// src/utils/pasteAgent.ts
//
// The resident helper that puts the chosen emoji at the user's cursor.
//
// Why this replaces "start a helper process on every paste"
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Folder under the user's local app data; also the name of the Startup shortcut. */
export const AGENT_DATA_FOLDER = 'Flow.Launcher.Plugin.EmojiFinder';

/** How long the agent waits for Flow to get out of the way before giving up, per request. */
const MAXIMUM_PASTE_WAIT_MILLISECONDS = 2500;

/** How often the agent looks for a new request. Cheap: it stats one small file. */
const POLL_INTERVAL_MILLISECONDS = 50;

/** A heartbeat older than this means the agent is not running any more. */
export const HEARTBEAT_STALE_AFTER_MILLISECONDS = 5000;

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
  const root = environment.LOCALAPPDATA ?? environment.TEMP ?? os.tmpdir();
  const directory = path.join(root, AGENT_DATA_FOLDER);

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
 */
export function buildAgentScript (paths: PasteAgentPaths): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'

$requestPath = '${toPowerShellLiteral(paths.request)}'
$heartbeatPath = '${toPowerShellLiteral(paths.heartbeat)}'
$logPath = '${toPowerShellLiteral(paths.log)}'
$pollMilliseconds = ${POLL_INTERVAL_MILLISECONDS}
$pasteWindowMilliseconds = ${MAXIMUM_PASTE_WAIT_MILLISECONDS}

$logDirectoryReady = $false
function Write-Trace([string] $message) {
  if (-not $logDirectoryReady) {
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) -ErrorAction SilentlyContinue
    $logDirectoryReady = $true
  }
  # Capped: a resident process must never be able to fill a disk.
  $existing = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
  if ($null -ne $existing -and $existing.Length -gt 262144) {
    Set-Content -LiteralPath $logPath -Value ''
  }
  $line = '{0} | agent | {1}' -f (Get-Date).ToString('o'), $message
  Add-Content -LiteralPath $logPath -Value $line -ErrorAction SilentlyContinue
}

# Variation selectors and zero-width joiners are invisible and are dropped by some
# clipboard producers, so they are ignored when comparing.
function Get-ComparableText([string] $text) {
  if ([string]::IsNullOrEmpty($text)) { return '' }
  return ($text -replace '[\\uFE0E\\uFE0F\\u200D]', '')
}

# Never run twice: a second copy would paste every emoji twice.
$existing = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $heartbeatPath) 'agent.pid') -ErrorAction SilentlyContinue
if ($existing) {
  $other = Get-Process -Id ([int]$existing) -ErrorAction SilentlyContinue
  if ($null -ne $other) {
    Write-Trace ("already running as pid={0}" -f $other.Id)
    exit 0
  }
}
$PID | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $heartbeatPath) 'agent.pid') -ErrorAction SilentlyContinue

Write-Trace ('start pid={0} ps={1}' -f $PID, $PSVersionTable.PSVersion.ToString())

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

# Requests seen before this process started are not pasted: after a restart the agent picks
# up from wherever the sequence number is now.
$lastSequence = 0
$x = Get-Content -LiteralPath $requestPath -Raw -ErrorAction SilentlyContinue
if ($x) {
  try { $lastSequence = [double](ConvertFrom-Json $x).sequence } catch { }
}

$lastHeartbeat = [DateTime]::MinValue

function Send-Paste([string] $targetEmoji) {
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $shouldPaste = $false
  $lastState = ''
  $loggedMismatch = $false

  while ($stopwatch.ElapsedMilliseconds -lt $pasteWindowMilliseconds) {
    $flowProcessIds = @()
    $flowVisible = $false
    foreach ($flowProcess in @(Get-Process -Name 'Flow.Launcher*' -ErrorAction SilentlyContinue)) {
      $flowProcessIds += $flowProcess.Id
      if ($flowProcess.MainWindowHandle -ne 0) { $flowVisible = $true }
    }

    $focusedProcessId = -1
    if ($focusProbeAvailable) {
      try {
        $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focusedElement) { $focusedProcessId = $focusedElement.Current.ProcessId }
      } catch { }
    }
    $flowHasFocus = ($focusedProcessId -ne -1) -and ($flowProcessIds -contains $focusedProcessId)

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

    $state = 'flowProcesses={0} flowVisible={1} flowHasFocus={2} focusedProcess={3} clipboardMatches={4} clipboardEmpty={5} clipboardError=[{6}]' -f $flowProcessIds.Count, $flowVisible, $flowHasFocus, $focusedProcessId, $clipboardMatches, ($clipboardText -eq ''), $clipboardError
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

    # Either signal is enough: "no visible window" or "focus went elsewhere".
    if ((-not $flowVisible -or -not $flowHasFocus) -and $clipboardMatches) {
      $shouldPaste = $true
      break
    }

    Start-Sleep -Milliseconds $pollMilliseconds
  }

  Write-Trace ('decision paste={0} elapsedMs={1}' -f $shouldPaste, $stopwatch.ElapsedMilliseconds)

  if ($shouldPaste) {
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
    (Get-Date).ToString('o') | Set-Content -LiteralPath $heartbeatPath -ErrorAction SilentlyContinue
    $lastHeartbeat = Get-Date
  }

  $content = Get-Content -LiteralPath $requestPath -Raw -ErrorAction SilentlyContinue
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
export function ensureAgentScript (paths: PasteAgentPaths = resolveAgentPaths()): string {
  const script = buildAgentScript(paths);

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

    return { running: age <= HEARTBEAT_STALE_AFTER_MILLISECONDS, heartbeatAgeMilliseconds: age };
  } catch {
    return { running: false, heartbeatAgeMilliseconds: null };
  }
}
