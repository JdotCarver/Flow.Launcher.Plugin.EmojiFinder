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
// The helper has to outlive our process, hence `detached: true` + `unref()`.
//
// Why PowerShell, and what it costs
// ---------------------------------
// It is the only key-injection route that needs no binary and no extra dependency, at
// the price of its own startup (~250-450 ms). A compiled helper or a cscript shim would
// be faster; both are documented alternatives in docs/PASTE_AT_CURSOR.md. Everything is
// behind `spawnPasteHelper`, so swapping the mechanism is one function.

import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * How long the helper keeps waiting for Flow to disappear and the clipboard to settle
 * before giving up. Long enough for a slow machine, short enough not to feel haunted.
 */
const MAXIMUM_WAIT_MILLISECONDS = 2000;

/** How often the helper re-checks its two conditions. */
const POLL_INTERVAL_MILLISECONDS = 15;

/**
 * Builds the PowerShell script the helper runs.
 *
 * Two conditions must both hold before a key is pressed:
 *   1. Flow Launcher no longer owns a visible main window (it has hidden itself);
 *   2. the clipboard contains the emoji we asked for (Flow writes it in-process, and
 *      that write can finish a few milliseconds after the window hides).
 *
 * If either condition never holds, the script does nothing at all: pressing Ctrl+V into
 * Flow's search box would paste the emoji back into the query, which is worse than a
 * missed paste.
 *
 * Exported for tests.
 */
export function buildPasteScript (emoji: string): string {
  // PowerShell single-quoted strings only need the quote itself escaped, by doubling it.
  const escapedEmoji = emoji.replaceAll("'", "''");

  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms

$targetEmoji = '${escapedEmoji}'
$timeoutMilliseconds = ${MAXIMUM_WAIT_MILLISECONDS}
$pollMilliseconds = ${POLL_INTERVAL_MILLISECONDS}
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$shouldPaste = $false

while ($stopwatch.ElapsedMilliseconds -lt $timeoutMilliseconds) {
  $flowWindowIsVisible = $false
  foreach ($flowProcess in (Get-Process -Name 'Flow.Launcher*' -ErrorAction SilentlyContinue)) {
    if ($flowProcess.MainWindowHandle -ne 0) { $flowWindowIsVisible = $true }
  }

  $clipboardHoldsEmoji = $false
  try { $clipboardHoldsEmoji = ([System.Windows.Forms.Clipboard]::GetText() -eq $targetEmoji) } catch { }

  if (-not $flowWindowIsVisible -and $clipboardHoldsEmoji) {
    $shouldPaste = $true
    break
  }

  Start-Sleep -Milliseconds $pollMilliseconds
}

if ($shouldPaste) {
  # Let the focus settle on the user's window before typing into it.
  Start-Sleep -Milliseconds 20
  [System.Windows.Forms.SendKeys]::SendWait('^v')
}
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

/**
 * Starts the detached helper. Resolves as soon as the process is spawned; we never wait
 * for it, and its exit code is nobody's business (it may outlive us by two seconds).
 *
 * @returns true when a helper was started, false on platforms without PowerShell.
 */
export function spawnPasteHelper (emoji: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-EncodedCommand', encodePowerShellCommand(buildPasteScript(emoji))
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  );

  // Detach: our process must be free to exit so Flow closes its window immediately.
  child.unref();

  return true;
}
