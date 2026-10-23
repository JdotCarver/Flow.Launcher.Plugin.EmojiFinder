// src/utils/pasteHelper.ts
//
// Sends Ctrl+V into whatever application the user was in, after Flow Launcher has
// stepped out of the way.
//
// Why this needs a separate, detached process
// -------------------------------------------
// Flow runs a result action *before* it hides its window. Anything we type from inside
// our own process would land in Flow's search box, not in the user's editor. So:
//
//   our process  ->  prints "copy this to the clipboard" for Flow, spawns the helper,
//                    exits (which lets Flow hide itself)
//   helper       ->  waits for Flow to be out of the way, then presses Ctrl+V
//
// The helper has to outlive our process, hence `detached: true` + `unref()`. Verified in
// Flow's source: it waits for our exit and calls `process.Kill()` (not the whole process
// tree) on timeout, so a detached child escapes both.
//
// How the helper decides Flow is out of the way
// ---------------------------------------------
// Two independent signals, because "hidden" and "minimized" look different to Windows:
//
//   1. focus      - the focused window belongs to a process that is not Flow
//                   (UI Automation, loaded as an assembly; compiles nothing),
//   2. visibility - no Flow process owns a visible main window (`MainWindowHandle`).
//
// Either one is enough. Signal 1 is what saves the feature when Flow minimizes to the
// tray instead of hiding, which leaves `MainWindowHandle` non-zero forever. If UI
// Automation cannot load, the helper falls back to signal 2 alone, exactly as before.
//
// Both signals are traced, so a run that ends in "nothing happened" says which condition
// stayed false. See docs/DOGFOODING.md.
//
// Why PowerShell, and what it costs
// ---------------------------------
// It is the only key-injection route that needs no binary and no extra dependency, at
// the price of its own startup (~250-450 ms). A compiled helper or a cscript shim would
// be faster; both are documented alternatives in docs/PASTE_AT_CURSOR.md. Everything is
// behind `spawnPasteHelper`, so swapping the mechanism is one function.

import { spawn } from 'node:child_process';
import process from 'node:process';
import { appendTraceLine, isTracingEnabled, TRACE_FILE } from './trace.js';

/**
 * How long the helper keeps waiting for Flow to disappear and the clipboard to settle
 * before giving up. Long enough for a slow machine, short enough not to feel haunted.
 */
const MAXIMUM_WAIT_MILLISECONDS = 2500;

/** How often the helper re-checks its conditions. */
const POLL_INTERVAL_MILLISECONDS = 20;

/** Escapes a value for a PowerShell single-quoted string (only the quote is special). */
function toPowerShellLiteral (value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Builds the PowerShell script the helper runs.
 *
 * The key is pressed only when all three hold:
 *   1. Flow does not have focus (or its focus state cannot be read),
 *   2. Flow has no visible main window,
 *   3. the clipboard holds the emoji we asked for.
 *
 * If they never hold, the script types nothing at all: pressing Ctrl+V into Flow's
 * search box would paste the emoji back into the query, which is worse than a missed
 * paste.
 *
 * @param emoji The emoji that should be on the clipboard by the time Ctrl+V is sent.
 * @param logPath Trace file, or an empty string to keep the helper completely silent.
 *
 * Exported for tests; every branch of it is asserted there.
 */
export function buildPasteScript (emoji: string, logPath: string = ''): string {
  const escapedEmoji = toPowerShellLiteral(emoji);
  const escapedLogPath = toPowerShellLiteral(logPath);

  return `
$ErrorActionPreference = 'SilentlyContinue'

$targetEmoji = '${escapedEmoji}'
$logPath = '${escapedLogPath}'
$timeoutMilliseconds = ${MAXIMUM_WAIT_MILLISECONDS}
$pollMilliseconds = ${POLL_INTERVAL_MILLISECONDS}

function Write-Trace([string] $message) {
  if ([string]::IsNullOrEmpty($logPath)) { return }
  $line = '{0} | helper | {1}' -f (Get-Date).ToString('o'), $message
  Add-Content -LiteralPath $logPath -Value $line -ErrorAction SilentlyContinue
}

# Variation selectors and zero-width joiners are invisible and are dropped by some
# clipboard producers, so they are ignored when comparing.
function Get-ComparableText([string] $text) {
  if ([string]::IsNullOrEmpty($text)) { return '' }
  return ($text -replace '[\\uFE0E\\uFE0F\\u200D]', '')
}

Write-Trace ('start pid={0} ps={1} apartment={2} policy={3} user={4}' -f $PID, $PSVersionTable.PSVersion.ToString(), [Threading.Thread]::CurrentThread.GetApartmentState().ToString(), (Get-ExecutionPolicy).ToString(), $env:USERNAME)

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

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$shouldPaste = $false
$lastState = ''
$loggedMismatch = $false

while ($stopwatch.ElapsedMilliseconds -lt $timeoutMilliseconds) {
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

  if ((-not $clipboardMatches) -and (-not $loggedMismatch) -and ($clipboardText -ne '')) {
    $clipboardCodes = ($clipboardText.ToCharArray() | ForEach-Object { [int]$_ }) -join ','
    $targetCodes = ($targetEmoji.ToCharArray() | ForEach-Object { [int]$_ }) -join ','
    Write-Trace ('mismatch clipboardCodes=[{0}] targetCodes=[{1}]' -f $clipboardCodes, $targetCodes)
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

Write-Trace 'exit'
`.trim();
}

/**
 * Encodes a script the way `powershell.exe -EncodedCommand` expects it: base64 of
 * UTF-16LE. This avoids every quoting, escaping and code-page problem that a `-Command`
 * string has with emoji and apostrophes.
 */
export function encodePowerShellCommand (script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export type PasteHelperStart =
  | { started: true, pid: number | undefined }
  | { started: false, reason: string };

/**
 * Starts the detached helper. Returns as soon as the process is spawned; we never wait
 * for it, and its exit code is nobody's business (it may outlive us by two seconds).
 */
export function spawnPasteHelper (emoji: string): PasteHelperStart {
  if (process.platform !== 'win32') {
    return { started: false, reason: `platform is ${process.platform}, paste injection is Windows-only` };
  }

  const logPath = isTracingEnabled() ? TRACE_FILE : '';
  const script = buildPasteScript(emoji, logPath);

  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-EncodedCommand', encodePowerShellCommand(script)
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }
    );

    // Spawn failures (ENOENT, blocked by policy) arrive asynchronously. Without a
    // listener, Node turns them into an uncaught exception.
    child.on('error', (error: Error) => {
      appendSpawnFailure(error);
    });

    // Detach: our process must be free to exit so Flow closes its window immediately.
    child.unref();

    return { started: true, pid: child.pid };
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Records an asynchronous spawn failure when tracing is on. There is nothing to recover
 * from here (the user is about to wonder why nothing was pasted), so the trace file is
 * the whole point.
 */
function appendSpawnFailure (error: Error): void {
  if (!isTracingEnabled()) {
    return;
  }

  appendTraceLine(TRACE_FILE, 'paste:spawn-error', { message: error.message });
}
