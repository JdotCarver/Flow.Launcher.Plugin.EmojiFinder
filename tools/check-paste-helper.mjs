// tools/check-paste-helper.mjs
//
// Runs the generated paste helper for real, on Windows, without Flow Launcher.
//
// Why this exists: the plugin's first traced run showed the helper process starting
// (pid 3772) and then writing nothing at all — not even its first line. `stdio: 'ignore'`
// meant PowerShell's own error message was thrown away, so the only way to know whether
// the script is invalid, blocked by policy, or silently killed is to run it here and look
// at the exit code and stderr.
//
// What it does
//   1. builds the helper script exactly as the plugin does (src/utils/pasteHelper.ts);
//   2. writes it to dogfood/paste-helper.generated.ps1 (readable, committable);
//   3. on Windows, runs it two ways and records exit code, stdout, stderr and whether a
//      trace line was written:
//        a. -EncodedCommand  (what the plugin uses today)
//        b. -File            (the fallback if encoding is what gets blocked)
//   4. writes dogfood/paste-helper-check.json.
//
// The script under test is given a log path inside dogfood/, so a successful run is
// visible as a file that grew. Nothing is typed into any window: the helper's conditions
// are never satisfied here, which is exactly the "safe" path through its logic.
//
// Usage
//   npm run check:paste-helper

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildPasteScript, encodePowerShellCommand } from '../dist/utils/pasteHelper.js';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const GENERATED_SCRIPT = path.join(DOGFOOD_DIRECTORY, 'paste-helper.generated.ps1');
const HELPER_LOG = path.join(DOGFOOD_DIRECTORY, 'paste-helper-check.log');
const REPORT_FILE = path.join(DOGFOOD_DIRECTORY, 'paste-helper-check.json');

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  staticChecks: [],
  runs: []
};

fs.mkdirSync(DOGFOOD_DIRECTORY, { recursive: true });

// --- 1. The script the plugin actually sends ---------------------------------------
const script = buildPasteScript('🙈', HELPER_LOG);
fs.writeFileSync(GENERATED_SCRIPT, script);
fs.rmSync(HELPER_LOG, { force: true });

// --- 2. Static checks: true everywhere, and enough to catch a broken template -------
staticCheck('script is not empty', script.trim().length > 0);
staticCheck('braces balance', count(script, '{') === count(script, '}'));
staticCheck('parentheses balance', count(script, '(') === count(script, ')'));
staticCheck('single quotes balance', count(script, "'") % 2 === 0);
staticCheck('no unresolved template placeholder', !script.includes('${'));
staticCheck('carries the emoji', script.includes("'🙈'"));
staticCheck('carries the log path', script.includes(HELPER_LOG.replaceAll("'", "''")));
staticCheck('writes trace lines', script.includes('Add-Content -LiteralPath $logPath'));

// --- 3. Real execution, on Windows only --------------------------------------------
if (process.platform === 'win32') {
  runWithEncodedCommand();
  runWithScriptFile();
} else {
  report.runs.push({ skipped: 'not Windows: execution checks need PowerShell' });
}

fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

printSummary();
process.exitCode = report.runs.some(run => run.ok === false) || report.staticChecks.some(check => !check.ok) ? 1 : 0;

// ---------------------------------------------------------------------------

function runWithEncodedCommand () {
  const encoded = encodePowerShellCommand(script);

  report.runs.push(capture('encoded-command', spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  )));
}

function runWithScriptFile () {
  // -ExecutionPolicy Bypass only because this file lives in a folder the user's policy
  // may not trust; the plugin's own helper does not need it.
  report.runs.push(capture('script-file', spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', GENERATED_SCRIPT],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  )));
}

/**
 * Turns a spawnSync result into a verdict, including whether the helper managed to write
 * its first trace line (the thing that was missing on the machine this debugged).
 */
function capture (label, result) {
  const logLines = readLines(HELPER_LOG);

  return {
    label,
    ok: result.status === 0 && logLines.length > 0,
    exitCode: result.status,
    signal: result.signal ?? '',
    spawnError: result.error?.message ?? '',
    standardOutput: (result.stdout ?? '').trim().slice(0, 2000),
    standardError: (result.stderr ?? '').trim().slice(0, 4000),
    traceLinesWritten: logLines.length,
    firstTraceLines: logLines.slice(0, 5)
  };
}

function readLines (file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function count (haystack, needle) {
  return haystack.split(needle).length - 1;
}

function staticCheck (label, ok) {
  report.staticChecks.push({ label, ok });
}

function printSummary () {
  console.log(`  script written to ${path.relative(PLUGIN_ROOT, GENERATED_SCRIPT)} (${script.length} chars)`);

  for (const check of report.staticChecks) {
    console.log(`  ${check.ok ? 'OK  ' : 'FAIL'}  ${check.label}`);
  }

  for (const run of report.runs) {
    if (run.skipped !== undefined) {
      console.log(`  skip  ${run.skipped}`);
      continue;
    }

    console.log(`  ${run.ok ? 'OK  ' : 'FAIL'}  ${run.label}: exit ${run.exitCode}, ${run.traceLinesWritten} trace line(s)`);

    if (run.ok === false) {
      if (run.standardError !== '') {
        console.log(`        stderr: ${run.standardError.split('\n').slice(0, 8).join('\n        ')}`);
      }

      if (run.standardOutput !== '') {
        console.log(`        stdout: ${run.standardOutput.split('\n').slice(0, 5).join('\n        ')}`);
      }

      if (run.spawnError !== '') {
        console.log(`        spawn: ${run.spawnError}`);
      }
    }
  }
}
