// tools/diagnose.mjs
//
// Collects everything that can only be learned on the user's Windows machine, and writes
// it to dogfood/diagnose.json so it can be committed and read from the Linux sandbox.
//
// Usage
//   npm run diagnose            # probe and write dogfood/diagnose.json
//   npm run diagnose -- --open  # also open the report in the default editor
//
// The report has two halves:
//   * plugin   - what this repository's build looks like (files, versions, trace state);
//   * windows  - the output of tools/windows-diagnostic.ps1, plus how long PowerShell
//                itself took to start (that is the paste feature's biggest cost).
//
// On a non-Windows machine the windows half is skipped with a note instead of failing:
// the plugin-side facts are still worth having.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const REPORT_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
/**
 * The committed report belongs to the machine that runs Flow Launcher. Running diagnose
 * on another platform (the Linux sandbox) must not destroy it, so non-Windows runs write
 * beside it instead of over it.
 */
const REPORT_FILE = path.join(REPORT_DIRECTORY, process.platform === 'win32' ? 'diagnose.json' : `diagnose-${process.platform}.json`);
const RUNTIME_LOG = path.join(REPORT_DIRECTORY, 'runtime.log');
const DIAGNOSTIC_SCRIPT = path.join(PLUGIN_ROOT, 'tools', 'windows-diagnostic.ps1');
const DIAGNOSTIC_OUTPUT = path.join(REPORT_DIRECTORY, 'windows-probe.json');

/** How many trace lines from the last dogfood run are included. */
const RUNTIME_TAIL_LINES = 80;

const report = {
  generatedAt: new Date().toISOString(),
  plugin: collectPluginFacts(),
  installedPlugin: describeInstalledPlugin(),
  powershellStartup: measurePowerShellStartup(),
  windows: null
};

report.windows = runWindowsDiagnostic();
report.pasteHelperTrace = collectRuntimeTrace();

fs.mkdirSync(REPORT_DIRECTORY, { recursive: true });
fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

printSummary(report);

if (process.argv.includes('--open')) {
  openInEditor(REPORT_FILE);
}

// ---------------------------------------------------------------------------

/**
 * What Flow Launcher is actually running, as opposed to what this repository builds.
 * Most "my change did nothing" reports are an installed copy that predates the build.
 */
function describeInstalledPlugin () {
  const pluginsDirectory = process.env.APPDATA === undefined
    ? null
    : path.join(process.env.APPDATA, 'FlowLauncher', 'Plugins', 'Flow.Launcher.Plugin.EmojiFinder');

  if (pluginsDirectory === null || !fs.existsSync(pluginsDirectory)) {
    return { found: false, note: 'not installed at %APPDATA%\\FlowLauncher\\Plugins (portable install?)' };
  }

  const entryPoint = path.join(pluginsDirectory, 'dist', 'main.js');
  const traceFile = path.join(pluginsDirectory, 'dogfood', 'runtime.log');

  return {
    found: true,
    directory: pluginsDirectory,
    builtEntryPointExists: fs.existsSync(entryPoint),
    builtAt: existsOrNull(entryPoint)?.mtime.toISOString() ?? '',
    repositoryBuildAt: existsOrNull(path.join(PLUGIN_ROOT, 'dist', 'main.js'))?.mtime.toISOString() ?? '',
    tracingEnabled: fs.existsSync(path.join(pluginsDirectory, 'trace.on')),
    traceFileExists: fs.existsSync(traceFile),
    traceFileBytes: existsOrNull(traceFile)?.size ?? 0,
    traceFileModifiedAt: existsOrNull(traceFile)?.mtime.toISOString() ?? ''
  };
}

function existsOrNull (filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function collectPluginFacts () {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    processArchitecture: process.arch,
    workingDirectory: process.cwd(),
    pluginRoot: PLUGIN_ROOT,
    builtEntryPointExists: fs.existsSync(path.join(PLUGIN_ROOT, 'dist', 'main.js')),
    iconCount: countEntries(path.join(PLUGIN_ROOT, 'icons')),
    emojiDataExists: fs.existsSync(path.join(PLUGIN_ROOT, 'node_modules', 'emojilib', 'dist', 'emoji-en-US.json')),
    tracingEnabled: fs.existsSync(path.join(PLUGIN_ROOT, 'trace.on')),
    traceFileExists: fs.existsSync(RUNTIME_LOG),
    packageVersion: readJson(path.join(PLUGIN_ROOT, 'package.json'))?.version ?? '',
    pluginVersion: readJson(path.join(PLUGIN_ROOT, 'plugin.json'))?.Version ?? ''
  };
}

/**
 * PowerShell's cold start is the dominant cost of paste-at-cursor, so measure it on the
 * machine that actually runs it.
 */
function measurePowerShellStartup () {
  if (process.platform !== 'win32') {
    return { skipped: 'not Windows' };
  }

  const startedAt = Date.now();
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  );

  return {
    milliseconds: Date.now() - startedAt,
    exitCode: result.status,
    version: (result.stdout ?? '').trim(),
    error: result.error?.message ?? '',
    standardError: (result.stderr ?? '').trim()
  };
}

/**
 * Runs the PowerShell probe and parses its JSON. Keeps raw output on failure: a syntax
 * error in the script is exactly the kind of thing that must survive into the report.
 */
function runWindowsDiagnostic () {
  if (process.platform !== 'win32') {
    return { skipped: 'not Windows: run `npm run diagnose` on the machine that runs Flow Launcher' };
  }

  if (!fs.existsSync(DIAGNOSTIC_SCRIPT)) {
    return { error: `missing ${DIAGNOSTIC_SCRIPT}` };
  }

  // The probe writes its report to a file: the first version printed JSON on stdout and
  // a single stray `True` (from Control.Focus()) corrupted it. Anything on stdout is now
  // diagnostic noise, kept for the record rather than parsed.
  fs.mkdirSync(REPORT_DIRECTORY, { recursive: true });
  fs.rmSync(DIAGNOSTIC_OUTPUT, { force: true });

  const startedAt = Date.now();
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', DIAGNOSTIC_SCRIPT,
      '-OutFile', DIAGNOSTIC_OUTPUT
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 }
  );

  const parsed = { milliseconds: Date.now() - startedAt, exitCode: result.status };

  if (result.error !== undefined) {
    parsed.error = result.error.message;
  }

  const stdout = (result.stdout ?? '').trim();
  if (stdout !== '') {
    parsed.standardOutput = stdout;
  }

  const stderr = (result.stderr ?? '').trim();
  if (stderr !== '') {
    parsed.standardError = stderr;
  }

  parsed.result = readJson(DIAGNOSTIC_OUTPUT) ?? undefined;

  if (parsed.result === undefined) {
    parsed.error = 'the probe did not write a readable report (see standardError)';
  }

  return parsed;
}

/**
 * Finds the trace, wherever it was written.
 *
 * The plugin writes next to itself, i.e. inside the *installed* folder, while the report
 * lives in the repository. Copying it back here is what makes "run diagnose, commit
 * dogfood/" a single step for the maintainer.
 */
function collectRuntimeTrace () {
  const candidates = [
    RUNTIME_LOG,
    installedPluginTrace()
  ].filter(candidate => candidate !== null && fs.existsSync(candidate));

  if (candidates.length === 0) {
    return {
      exists: false,
      note: 'no trace file: install with "npm run package -- --install --trace", reproduce, then run this again'
    };
  }

  const source = candidates[0];

  if (source !== RUNTIME_LOG) {
    fs.mkdirSync(REPORT_DIRECTORY, { recursive: true });
    fs.copyFileSync(source, RUNTIME_LOG);
  }

  const lines = fs.readFileSync(RUNTIME_LOG, 'utf8').trim().split('\n').filter(Boolean);

  return {
    exists: true,
    source,
    copiedIntoRepository: source !== RUNTIME_LOG,
    totalLines: lines.length,
    lastLines: lines.slice(-RUNTIME_TAIL_LINES)
  };
}

/**
 * Path of the trace inside the plugin that Flow Launcher actually loads, if any.
 */
function installedPluginTrace () {
  const appData = process.env.APPDATA;

  if (appData === undefined) {
    return null;
  }

  return path.join(appData, 'FlowLauncher', 'Plugins', 'Flow.Launcher.Plugin.EmojiFinder', 'dogfood', 'runtime.log');
}

function printSummary (diagnosis) {
  console.log(`report written to ${path.relative(PLUGIN_ROOT, REPORT_FILE)}`);

  if (process.platform !== 'win32') {
    console.log('  (not Windows, so this is a side report: dogfood/diagnose.json is left untouched)');
  }

  const installed = diagnosis.installedPlugin ?? {};
  if (installed.found === true) {
    console.log(`  installed plugin: built ${installed.builtAt}, tracing ${installed.tracingEnabled ? 'ON' : 'OFF'}, trace ${installed.traceFileExists ? `${installed.traceFileBytes} bytes` : 'missing'}`);
  } else {
    console.log(`  installed plugin: ${installed.note}`);
  }

  const windows = diagnosis.windows ?? {};

  if (windows.skipped !== undefined) {
    console.log(`  windows probes: skipped (${windows.skipped})`);
  } else if (windows.result === undefined) {
    console.log('  windows probes: FAILED, see rawStandardOutput/rawStandardError in the report');
  } else {
    const result = windows.result;
    console.log(`  powershell startup: ${diagnosis.powershellStartup.milliseconds} ms`);
    console.log(`  winforms load: ${result.winForms?.ok === true ? 'ok' : `FAILED: ${result.winForms?.error}`}`);
    console.log(`  clipboard round-trip: ${describeClipboard(result.clipboard)}`);
    console.log(`  sendkeys self-test: ${result.sendKeys?.ok === true ? 'ok' : `FAILED: ${result.sendKeys?.error || `typed "${result.sendKeys?.typed}"`}`}`);
    console.log(`  flow processes: ${(result.flowProcesses ?? []).length} (visible main window: ${countVisibleFlowWindows(result)})`);
    console.log(`  ui automation focus probe: ${describeUiAutomation(result.uiAutomation)}`);
  }

  console.log(`  trace lines: ${diagnosis.pasteHelperTrace.totalLines ?? 0}`);
  console.log('\ncommit dogfood/ so the next session can read it.');
}

function describeClipboard (clipboard) {
  if (clipboard === undefined) return 'not run';
  if (clipboard.error !== '') return clipboard.error;

  return (clipboard.tests ?? [])
    .map(test => `${test.matches ? 'ok' : `MISMATCH (wrote ${test.writtenCodes || '?'}, read ${test.readCodes || '?'})`}`)
    .join(', ');
}

function describeUiAutomation (uiAutomation) {
  if (uiAutomation === undefined) return 'not run';
  if (uiAutomation.ok !== true) return `unavailable: ${uiAutomation.error}`;

  return `ok in ${uiAutomation.milliseconds} ms, focused process ${uiAutomation.focusedProcessId} (${uiAutomation.focusedName || 'no name'})`;
}

function countVisibleFlowWindows (result) {
  return (result.flowProcesses ?? []).filter(entry => entry.mainWindowHandle !== 0).length;
}

function countEntries (directory) {
  try {
    return fs.readdirSync(directory).length;
  } catch {
    return 0;
  }
}

function readJson (filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function openInEditor (filePath) {
  const command = process.platform === 'win32' ? 'notepad.exe' : 'cat';
  spawnSync(command, [filePath], { stdio: 'inherit' });
}
