// src/utils/pasteAgent.ts
//
// The resident agent that puts the chosen emoji at the user's cursor.
//
// Why this replaces "start a process on every paste"
// --------------------------------------------------------
// A Flow Launcher plugin is a one-shot process: it is started, returns a result, and is
// destroyed. Measured on the real machine, everything it spawns is destroyed with it - the
// plugin logged `paste:spawn started=true pid=... ready=true` three times, which proves
// PowerShell started and printed its first line, and then the helper wrote nothing at all,
// because it was killed before its second statement. Detaching, `unref`, waiting for a
// readiness line, `cmd /c start`: none of it helps.
//
// So the helper is not started per paste. It is *resident*: one PowerShell process, started
// once (by the installer and at login), which waits for requests. WhisperWriter and Espanso
// work the same way, for the same reason.
//
// The protocol
// ------------
// No socket, no port, no named pipe. Two small files in the user's local app data folder:
//
//   request.json   - written by the plugin: { "emoji": "...", "sequence": 17 }
//   heartbeat.txt  - written by the agent about once a second
//
// The sequence number is a timestamp, so the same emoji twice in a row is two pastes, and a
// restarted agent never replays an old request. A missing or stale heartbeat is how the
// plugin knows the agent is not running - it then traces a clear message instead of
// pretending the paste happened.
//
// Portable Flow Launcher
// ----------------------
// Nothing here is derived from where Flow Launcher is installed. The agent script, the
// request file and the heartbeat all live in %LOCALAPPDATA%, and the Startup entry is per
// user, so a portable installation on a USB stick uses exactly the same code path.
//
// See docs/PASTE_AGENT.md for what running this means for the user (one hidden background
// process, ~40-60 MB, one file check every 50 ms).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Folder under the user's local app data; also the name of the Startup shortcut. */
export const AGENT_DATA_FOLDER = 'Flow.Launcher.Plugin.EmojiFinder';

/**
 * Environment variable that moves the agent's files somewhere else.
 *
 * For the checks, and for anyone who wants a second, isolated agent while developing. The
 * plugin never sets it: in normal use the folder is the one above.
 */
export const AGENT_DIRECTORY_VARIABLE = 'EMOJI_PASTE_AGENT_DIRECTORY';

/** How long the agent waits for Flow to get out of the way before giving up, per request. */
const MAXIMUM_PASTE_WAIT_MILLISECONDS = 2500;

/** How often the agent looks for a new request. Cheap: it stats one small file. */
const POLL_INTERVAL_MILLISECONDS = 50;

/**
 * The name Flow Launcher's process runs under.
 *
 * Flow keeps this process alive after its window hides, so the only question the agent can
 * ask is which window has focus - the process itself is always there.
 */
export const FLOW_PROCESS_NAME = 'Flow.Launcher*';

/**
 * Environment variable that renames the process the agent treats as Flow Launcher.
 *
 * Only the checks set it, and only to `*`: with every process counted as Flow, the agent must
 * refuse to paste, which is how the focus gate is proven without typing into a window.
 */
export const FLOW_PROCESS_NAME_VARIABLE = 'EMOJI_PASTE_AGENT_FLOW_PROCESS';

/**
 * How long the agent waits before pasting blind when the automation probe never loaded.
 *
 * Pasting blind is the bug this replaced: a keystroke sent while Flow still held focus landed
 * in Flow's hidden query box and reappeared when the launcher was next opened. Without the
 * probe there is no way to know, so a paste 250 ms late is the lesser evil - and the case is
 * logged every time it is used.
 */
export const FOCUS_PROBE_UNAVAILABLE_DELAY_MILLISECONDS = 250;

/**
 * How old a request may be and still be pasted when the agent starts.
 *
 * The plugin starts the agent when it notices none is running, and it publishes the request
 * first - the only order that works, because the plugin is destroyed the moment it returns.
 * A request younger than this is therefore the one the user just made, not history.
 */
export const STARTUP_GRACE_MILLISECONDS = 15000;

/** A heartbeat older than this means the agent is not running any more. */
export const HEARTBEAT_STALE_AFTER_MILLISECONDS = 5000;

/** The agent writes its own process id here, beside the heartbeat. */
export const AGENT_PID_FILE_NAME = 'agent.pid';

/**
 * A tiny VBScript launcher, used everywhere the agent is started.
 *
 * PowerShell is a console program: started directly (Startup shortcut, Task Scheduler) it
 * allocates a console window and hides it a moment later, which the user sees as a black
 * flash. `wscript.exe` has no console at all, and `WshShell.Run` with window style 0 asks
 * for no window in the first place, so nothing ever appears.
 */
export const AGENT_LAUNCHER_FILE_NAME = 'paste-agent-launcher.vbs';

export interface PasteAgentPaths {
  directory: string;
  script: string;
  request: string;
  heartbeat: string;
  log: string;
}

export interface PasteAgentStatus {
  running: boolean;
  heartbeatAgeMilliseconds: number | null;
}

/**
 * Where the agent and its files live.
 *
 * `%LOCALAPPDATA%` is per user, writable without elevation, and identical for installed and
 * portable Flow Launcher. Falls back to the temp folder on a machine where the variable is
 * missing, so nothing here can throw.
 *
 * @param environment Injected for tests.
 */
export function resolveAgentPaths (environment: NodeJS.ProcessEnv = process.env): PasteAgentPaths {
  // An explicit folder wins. The checks use it to run their own agent in a temporary folder,
  // so proving the agent works never stops the user's agent - which used to interrupt paste
  // for a minute on every Windows run, and looked exactly like an intermittent bug.
  const overridden = environment[AGENT_DIRECTORY_VARIABLE]?.trim();

  if (overridden !== undefined && overridden !== '') {
    return pathsIn(path.resolve(overridden));
  }

  const root = environment.LOCALAPPDATA ?? environment.TEMP ?? os.tmpdir();

  return pathsIn(path.join(root, AGENT_DATA_FOLDER));
}

/** The file names are fixed; only the folder varies. */
function pathsIn (directory: string): PasteAgentPaths {
  return {
    directory,
    script: path.join(directory, 'paste-agent.ps1'),
    request: path.join(directory, 'request.json'),
    heartbeat: path.join(directory, 'heartbeat.txt'),
    log: path.join(directory, 'agent.log')
  };
}

/** Escapes a value for a PowerShell single-quoted string (only the quote is special). */
function toPowerShellLiteral (value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * The agent script.
 *
 * Its shape is a loop around the decision logic that used to run once per paste: wait for
 * Flow to be out of the way, check the clipboard really holds the emoji, then press Ctrl+V.
 * That logic is unchanged and still tested; what is new is that the process doing it is
 * already running when the user presses Enter.
 *
 * It logs *always*, not only when tracing is on. A resident process that runs silently is
 * undiagnosable: the one question that matters when paste does nothing - did the request
 * ever arrive? - can only be answered by the agent itself, and by the time the user reports
 * it, the moment is gone. The file is capped and lives with the agent's own state.
 *
 * @param paths Where the agent reads requests and writes its heartbeat and log.
 * @param flowProcessName The process name Flow Launcher runs under. Only the checks change it.
 */
export function buildAgentScript (
  paths: PasteAgentPaths,
  flowProcessName: string = FLOW_PROCESS_NAME
): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'

$requestPath = '${toPowerShellLiteral(paths.request)}'
$heartbeatPath = '${toPowerShellLiteral(paths.heartbeat)}'
$logPath = '${toPowerShellLiteral(paths.log)}'
$pollMilliseconds = ${POLL_INTERVAL_MILLISECONDS}
$pasteWindowMilliseconds = ${MAXIMUM_PASTE_WAIT_MILLISECONDS}
$startupGraceMilliseconds = ${STARTUP_GRACE_MILLISECONDS}
$blindDelayMilliseconds = ${FOCUS_PROBE_UNAVAILABLE_DELAY_MILLISECONDS}

# Flow Launcher's process, not its ID: it is started once and stays, so matching the name is
# the only thing that survives a restart of the launcher.
$flowProcessName = '${toPowerShellLiteral(flowProcessName)}'

# Every file read and write below goes through .NET with an explicit UTF-8 encoding.
# Get-Content/Add-Content/Set-Content take their encoding from the host's defaults, and those
# defaults differ between Windows PowerShell 5.1 and PowerShell 7 - which is how an emoji
# turned into four meaningless characters (240,376,167,170) and every paste silently refused.
# Explicit encodings cannot drift with the host.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$logDirectoryReady = $false
function Write-Trace([string] $message) {
  if (-not $logDirectoryReady) {
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) -ErrorAction SilentlyContinue
    $logDirectoryReady = $true
  }
  $line = '{0} | agent | {1}' -f (Get-Date).ToString('o'), $message
  try {
    # Capped: a resident process must never be able to fill a disk.
    $existing = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
    if ($null -ne $existing -and $existing.Length -gt 262144) {
      [System.IO.File]::WriteAllText($logPath, '', $utf8NoBom)
    }
    [System.IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, $utf8NoBom)
  } catch { }
}

# Variation selectors and zero-width joiners are invisible and are dropped by some
# clipboard producers, so they are ignored when comparing.
function Get-ComparableText([string] $text) {
  if ([string]::IsNullOrEmpty($text)) { return '' }
  return ($text -replace '[\\uFE0E\\uFE0F\\u200D]', '')
}

# Never run twice: a second copy would paste every emoji twice.
$pidPath = Join-Path (Split-Path -Parent $heartbeatPath) 'agent.pid'
$existing = $null
try { $existing = [System.IO.File]::ReadAllText($pidPath).Trim() } catch { }
if ($existing) {
  $other = Get-Process -Id ([int]$existing) -ErrorAction SilentlyContinue
  if ($null -ne $other) {
    Write-Trace ("already running as pid={0}" -f $other.Id)
    exit 0
  }
}
try { [System.IO.File]::WriteAllText($pidPath, [string]$PID, $utf8NoBom) } catch { }

# The host and its version are logged because the two PowerShell hosts behave differently
# around text encoding, and a report without this line cannot tell them apart.
$hostName = [System.Diagnostics.Process]::GetCurrentProcess().ProcessName
Write-Trace ('start pid={0} host={1} ps={2} edition={3}' -f $PID, $hostName, $PSVersionTable.PSVersion.ToString(), $PSVersionTable.PSEdition)

try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  Write-Trace 'winforms loaded'
} catch {
  Write-Trace ('winforms-error: ' + $_.Exception.Message)
}

# Focus detection: an assembly load, not a compilation, so it is cheap. Kept optional.
$focusProbeAvailable = $false
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  $focusProbeAvailable = $true
  Write-Trace 'uiautomation loaded'
} catch {
  Write-Trace ('uiautomation-error: ' + $_.Exception.Message)
}

# Which process owns the window with focus, or -1 when that cannot be answered.
function Get-FocusedProcessId {
  if (-not $focusProbeAvailable) { return -1 }
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $focused) { return [int]$focused.Current.ProcessId }
  } catch { }
  return -1
}

# The window handle of the focused element, for the log only. 0 when it cannot be found.
#
# The focused element is usually a control inside a window (a text box), which reports no
# handle of its own, so its ancestors are walked until one has a handle. Bounded on purpose:
# a walk with no depth limit is a loop waiting to happen.
#
# The title is never read: it is the user's text, and the log is plain text on disk.
function Get-FocusedWindowHandle {
  if (-not $focusProbeAvailable) { return 0 }
  try {
    $element = [System.Windows.Automation.AutomationElement]::FocusedElement
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth = 0; $depth -lt 12; $depth++) {
      if ($null -eq $element) { break }
      if ($element.Current.NativeWindowHandle -ne 0) { return [int]$element.Current.NativeWindowHandle }
      $element = $walker.GetParent($element)
    }
  } catch { }
  return 0
}

# Requests older than the startup grace are not pasted: after a restart the agent picks up
# from wherever the sequence number is now, so yesterday's request cannot fire twice. A
# request younger than that is the reason this process was started at all - the plugin
# publishes and then starts the agent, in that order, because it is destroyed on return.
$lastSequence = 0
function Read-Request {
  # File.ReadAllText with an explicit encoding also strips a byte-order mark, which
  # ConvertFrom-Json would otherwise choke on.
  try {
    return [System.IO.File]::ReadAllText($requestPath, [System.Text.Encoding]::UTF8)
  } catch {
    return ''
  }
}

$x = Read-Request
if ($x) {
  try {
    $pendingSequence = [double](ConvertFrom-Json $x).sequence
    $pendingAge = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $pendingSequence
    if ($pendingAge -le $startupGraceMilliseconds) {
      Write-Trace ('adopting recent request sequence={0} ageMs={1}' -f $pendingSequence, $pendingAge)
    } else {
      $lastSequence = $pendingSequence
    }
  } catch { }
}

$lastHeartbeat = [DateTime]::MinValue

# Why the gate is focus-only, and why the window handle is not a signal
# ---------------------------------------------------------------------
# The rule used to be "no visible Flow window OR focus went elsewhere". The first half was
# always true: the process reports no main window even while its window is on screen
# (measured: 672 polls out of 672 across a full day of dogfooding), so the focus test never
# ran and every request pasted on its first poll.
#
# When that poll landed while Flow still held focus - which is what a repeated emoji produces,
# because the clipboard already holds it and the gate opens at ~9 ms instead of waiting for
# Flow's copy - the keystroke went into Flow's hidden query box. Flow hides rather than closes
# on Enter, so the emoji was there when the launcher was next opened: the bug reported as
# "the paste agent is failing to recognise that the focus has switched".
function Send-Paste([string] $targetEmoji) {
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $shouldPaste = $false
  $lastState = ''
  $loggedMismatch = $false
  $loggedBlind = $false
  $beforeFlowProcess = -1

  while ($stopwatch.ElapsedMilliseconds -lt $pasteWindowMilliseconds) {
    $flowProcessIds = @(Get-Process -Name $flowProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $focusedProcessId = Get-FocusedProcessId
    $flowHasFocus = ($focusedProcessId -ne -1) -and ($flowProcessIds -contains $focusedProcessId)

    # The last app that had focus while it was not Flow. Flow keeps its process, so this is
    # what the user was in a moment ago; it is logged beside the destination to make an
    # after-the-fact report readable.
    if (($focusedProcessId -ne -1) -and (-not $flowHasFocus)) { $beforeFlowProcess = $focusedProcessId }

    $clipboardText = ''
    $clipboardError = ''
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $clipboardText = [System.Windows.Forms.Clipboard]::GetText()
      }
    } catch {
      $clipboardError = $_.Exception.Message
    }

    $clipboardMatches = $false
    if ($clipboardText -ne '') {
      $clipboardMatches = ((Get-ComparableText $clipboardText) -eq (Get-ComparableText $targetEmoji))
    }

    $state = 'flowProcesses={0} flowHasFocus={1} focusedProcess={2} clipboardMatches={3} clipboardEmpty={4} clipboardError=[{5}]' -f $flowProcessIds.Count, $flowHasFocus, $focusedProcessId, $clipboardMatches, ($clipboardText -eq ''), $clipboardError
    if ($state -ne $lastState) {
      Write-Trace ('poll ' + $state)
      $lastState = $state
    }

    # Once per request: what the clipboard actually holds. Without this, "the clipboard never
    # matched" is the end of the investigation instead of the start of it.
    if ((-not $clipboardMatches) -and (-not $loggedMismatch) -and ($clipboardText -ne '')) {
      $clipboardCodes = ($clipboardText.ToCharArray() | ForEach-Object { [int]$_ }) -join ','
      Write-Trace ('mismatch clipboardCodes=[{0}] clipboardLength={1}' -f $clipboardCodes, $clipboardText.Length)
      $loggedMismatch = $true
    }

    # The gate: the clipboard holds the emoji AND Flow is not the window with focus.
    #
    # Nothing else counts as ready. See docs/PASTE_AGENT.md for why "no visible Flow window"
    # was removed from this rule instead of being kept beside it.
    if ($clipboardMatches -and (-not $focusProbeAvailable)) {
      if (-not $loggedBlind) {
        Write-Trace ('focus probe unavailable: pasting after the blind delay of {0} ms' -f $blindDelayMilliseconds)
        $loggedBlind = $true
      }
      if ($stopwatch.ElapsedMilliseconds -ge $blindDelayMilliseconds) {
        $shouldPaste = $true
        break
      }
    } elseif ($clipboardMatches -and ($focusedProcessId -ne -1) -and (-not $flowHasFocus)) {
      $shouldPaste = $true
      break
    }

    Start-Sleep -Milliseconds $pollMilliseconds
  }

  Write-Trace ('decision paste={0} elapsedMs={1}' -f $shouldPaste, $stopwatch.ElapsedMilliseconds)

  if ($shouldPaste) {
    # Where it is about to go: the process and the window handle, never the title. Without a
    # destination in the log, "it pasted somewhere unexpected" costs another round trip.
    Write-Trace ('destination pid={0} hwnd=0x{1:x} beforeFlowProcess={2}' -f (Get-FocusedProcessId), (Get-FocusedWindowHandle), $beforeFlowProcess)

    Start-Sleep -Milliseconds 20
    try {
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Write-Trace 'sendkeys sent'
    } catch {
      Write-Trace ('sendkeys-error: ' + $_.Exception.Message)
    }
  }
}

Write-Trace 'waiting for requests'

while ($true) {
  if (((Get-Date) - $lastHeartbeat).TotalMilliseconds -gt 500) {
    try {
      [System.IO.File]::WriteAllText($heartbeatPath, (Get-Date).ToString('o'), $utf8NoBom)
    } catch { }
    $lastHeartbeat = Get-Date
  }

  $content = Read-Request
  if ($content) {
    $request = $null
    try { $request = ConvertFrom-Json $content } catch { }

    if ($null -ne $request -and [double]$request.sequence -gt $lastSequence) {
      $lastSequence = [double]$request.sequence
      # Code points, not just the glyph: an encoding mistake in the request file looks
      # exactly like "the clipboard never matched", and this is what tells them apart.
      $targetCodes = ($request.emoji.ToCharArray() | ForEach-Object { [int]$_ }) -join ','
      Write-Trace ("request sequence={0} emoji=[{1}] targetCodes=[{2}]" -f $request.sequence, $request.emoji, $targetCodes)
      Send-Paste ([string]$request.emoji)
    }
  }

  Start-Sleep -Milliseconds $pollMilliseconds
}
`.trim();
}

/**
 * Writes the agent script, but only when its content changed.
 *
 * Rewriting it on every paste would be pointless disk traffic, and replacing the file while
 * the agent is running is harmless anyway - PowerShell has already read it.
 */
export function ensureAgentScript (
  paths: PasteAgentPaths = resolveAgentPaths(),
  flowProcessName: string = resolveFlowProcessName()
): string {
  const script = buildAgentScript(paths, flowProcessName);

  fs.mkdirSync(paths.directory, { recursive: true });

  let existing = '';
  try {
    existing = fs.readFileSync(paths.script, 'utf8');
  } catch {
    // Missing file is the normal case on first run.
  }

  if (existing !== script) {
    fs.writeFileSync(paths.script, script);
  }

  return paths.script;
}

/** Where the launcher lives: beside the agent script, in the per-user data folder. */
export function agentLauncherPath (paths: PasteAgentPaths = resolveAgentPaths()): string {
  return path.join(paths.directory, AGENT_LAUNCHER_FILE_NAME);
}

/**
 * The process name the agent treats as Flow Launcher.
 *
 * `EMOJI_PASTE_AGENT_FLOW_PROCESS` overrides it, which is how the checks prove the focus
 * gate: with `*` every process counts as Flow, so the agent must refuse to paste even when
 * the clipboard holds exactly the emoji it was asked for.
 */
export function resolveFlowProcessName (environment: NodeJS.ProcessEnv = process.env): string {
  const overridden = environment[FLOW_PROCESS_NAME_VARIABLE]?.trim();

  if (overridden !== undefined && overridden !== '') {
    return overridden;
  }

  return FLOW_PROCESS_NAME;
}

/**
 * Which PowerShell should host the agent.
 *
 * PowerShell 7 is preferred when it is on `PATH`, because it starts faster; Windows
 * PowerShell 5.1 is the fallback, and it is on every Windows machine, so this never returns
 * something that is not installed. `EMOJI_PASTE_AGENT_HOST` overrides both, which is how the
 * checks run the agent under each host in turn.
 *
 * `PATH` is searched by looking at the folders rather than by asking `where.exe`, because a
 * Flow Launcher action that spawns a process just to answer a question is the kind of cost
 * this feature exists to avoid.
 */
export function resolvePowerShellHost (environment: NodeJS.ProcessEnv = process.env): string {
  const overridden = environment.EMOJI_PASTE_AGENT_HOST?.trim();

  if (overridden !== undefined && overridden !== '') {
    return overridden;
  }

  const folders = (environment.PATH ?? '').split(path.delimiter).filter((folder) => folder !== '');

  for (const folder of folders) {
    const candidate = path.join(folder, 'pwsh.exe');

    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // An unreadable PATH entry is not an answer; keep looking.
    }
  }

  return 'powershell.exe';
}

/**
 * The VBScript launcher, as text.
 *
 * Kept tiny on purpose: it starts one process, with no window, and exits immediately. The
 * agent is therefore not a child of the plugin (which Flow destroys) nor of this script.
 *
 * @param paths Where the agent script lives.
 * @param host The PowerShell executable to run it with.
 */
export function buildAgentLauncherScript (paths: PasteAgentPaths, host: string): string {
  const commandLine = `"${host}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${paths.script}"`;
  // In VBScript a double quote inside a string literal is written twice, so the argument
  // quoting above has to be escaped again.
  const commandLiteral = commandLine.replaceAll('"', '""');

  return [
    "' paste-agent-launcher.vbs",
    "'",
    "' Starts the Emoji Finder paste agent with no window at all.",
    "'",
    "' PowerShell is a console program: started directly it allocates a console window and hides",
    "' it a moment later, which the user sees as a black flash every time the agent starts.",
    "' wscript.exe has no console, and window style 0 asks for no window in the first place.",
    "'",
    "' Written by the plugin; safe to delete while the agent is not running.",
    '',
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    "' 0 = no window at all, False = do not wait for it to finish.",
    `shell.Run "${commandLiteral}", 0, False`,
    ''
  ].join('\r\n');
}

/**
 * Writes the launcher if it differs from what this build generates.
 *
 * @returns The launcher's path.
 */
export function ensureAgentLauncher (
  paths: PasteAgentPaths = resolveAgentPaths(),
  host: string = resolvePowerShellHost()
): string {
  const launcher = agentLauncherPath(paths);
  const script = buildAgentLauncherScript(paths, host);

  fs.mkdirSync(paths.directory, { recursive: true });

  let existing = '';
  try {
    existing = fs.readFileSync(launcher, 'utf8');
  } catch {
    // Missing file is the normal case on first run.
  }

  if (existing !== script) {
    fs.writeFileSync(launcher, script);
  }

  return launcher;
}

/**
 * Starts the agent when it is not already running.
 *
 * Used by the paste action, so that a machine that has just booted - or whose agent was
 * stopped for any reason - still pastes instead of silently doing nothing. The request is
 * already on disk by the time this runs, and the agent adopts requests younger than
 * `STARTUP_GRACE_MILLISECONDS`, so the first paste works; it just arrives a moment later.
 *
 * Nothing here waits: this process is destroyed as soon as the action returns.
 *
 * @returns Whether a launcher was started. Whether an agent came up is in the log.
 */
export function startPasteAgent (
  paths: PasteAgentPaths = resolveAgentPaths(),
  host: string = resolvePowerShellHost()
): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const launcher = ensureAgentLauncher(paths, host);

  // wscript.exe shows nothing and exits at once; the agent outlives both it and us.
  try {
    const child = spawn('wscript.exe', [launcher], { stdio: 'ignore', windowsHide: true });
    // A missing wscript.exe or a policy that blocks it arrives as an 'error' event, and an
    // unhandled one would take the plugin down with it.
    child.on('error', () => startAgentDirectly(paths, host));
    child.unref();

    return true;
  } catch {
    return startAgentDirectly(paths, host);
  }
}

/** The fallback when wscript is unavailable: a hidden PowerShell, console and all. */
function startAgentDirectly (paths: PasteAgentPaths, host: string): boolean {
  try {
    const child = spawn(
      host,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', paths.script],
      { stdio: 'ignore', windowsHide: true }
    );
    child.on('error', () => { });
    child.unref();

    return true;
  } catch {
    return false;
  }
}

/**
 * Publishes a paste request.
 *
 * Written to a temporary file and renamed, because the agent may read it at the same moment:
 * a half-written JSON file would be a request that silently does nothing.
 *
 * @returns The sequence number used, and whether an agent was alive to act on it.
 */
export function requestPaste (
  emoji: string,
  paths: PasteAgentPaths = resolveAgentPaths()
): { sequence: number, agentRunning: boolean } {
  fs.mkdirSync(paths.directory, { recursive: true });

  const sequence = nextSequence(paths, Date.now());
  const temporaryFile = `${paths.request}.tmp`;

  fs.writeFileSync(temporaryFile, JSON.stringify({ emoji, sequence }));
  fs.renameSync(temporaryFile, paths.request);

  return { sequence, agentRunning: readAgentStatus(paths).running };
}

/**
 * Timestamps make a good sequence: monotonic in practice, and never replays an old request.
 * The +1 guards the one case that is not - two requests inside the same millisecond.
 */
function nextSequence (paths: PasteAgentPaths, now: number): number {
  try {
    const previous = JSON.parse(fs.readFileSync(paths.request, 'utf8')) as { sequence?: number };

    return Math.max(now, Number(previous.sequence ?? 0) + 1);
  } catch {
    return now;
  }
}

/**
 * Whether the agent is alive, judged by its heartbeat.
 *
 * A file rather than a process lookup on purpose: the agent may run in a different session,
 * and `Get-Process` from Node would drag in platform-specific code for no benefit.
 */
export function readAgentStatus (paths: PasteAgentPaths = resolveAgentPaths()): PasteAgentStatus {
  try {
    const age = Date.now() - fs.statSync(paths.heartbeat).mtimeMs;

    if (age > HEARTBEAT_STALE_AFTER_MILLISECONDS) {
      return { running: false, heartbeatAgeMilliseconds: age };
    }

    // A heartbeat keeps looking fresh for up to five seconds after its process dies, and that
    // window is not academic: an agent killed just before a paste made the plugin - and the
    // installer - answer "already running" and start nothing, so paste did nothing at all.
    // Asking the process itself closes the window.
    const pid = readAgentProcessId(paths);

    if (pid !== null && !isProcessAlive(pid)) {
      return { running: false, heartbeatAgeMilliseconds: age };
    }

    return { running: true, heartbeatAgeMilliseconds: age };
  } catch {
    return { running: false, heartbeatAgeMilliseconds: null };
  }
}

/**
 * The pid the agent published, or null when it has not published one.
 *
 * A pid file that cannot be parsed is treated as absent rather than as a reason to report the
 * agent dead: a half-written file is a moment in time, not an answer.
 */
function readAgentProcessId (paths: PasteAgentPaths): number | null {
  try {
    const value = Number.parseInt(fs.readFileSync(path.join(paths.directory, AGENT_PID_FILE_NAME), 'utf8').trim(), 10);

    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether a process with this id exists.
 *
 * Signal 0 performs the existence check without sending anything. `EPERM` means the process is
 * there but owned by somebody else, which still counts: the agent is per user, so this only
 * happens if the pid was recycled by an unrelated process.
 */
function isProcessAlive (pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
