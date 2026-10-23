// tools/paste-exit-probe.mjs
//
// Reproduces the one condition the spawn probe could not: the parent process exiting
// immediately after it starts the helper.
//
// Timeline of what we now know from the real machine:
//
//   probe (parent stays alive 6 s)        helper writes 6 trace lines  -> works
//   Flow (parent exits right after)        helper writes 0 lines         -> dies
//
// Flow runs a result action, takes the "hide myself" flag and kills our plugin process. So
// the question is no longer "how is the child spawned" but "what happens to it when we
// disappear". Three candidates, three variants:
//
//   plain        production spawnPasteHelper(), parent exits immediately
//   node-marker  the simplest possible child (node writes a file): does *any* child
//                survive our exit, or is the process tree being taken down?
//   start-shim   powershell launched through `cmd /c start /b`, which hands it to a new
//                process tree; the fallback if plain children do not survive
//   launcher     a DETACHED node process is started, and *it* starts PowerShell normally.
//                Detached is what failed for PowerShell itself (no console, exits 0), but a
//                console-less node process is perfectly happy - so this buys survival
//                without handing PowerShell a new process group.
//
// Each variant is spawned by a short-lived node process that exits at once, because a probe
// cannot observe its own death. The outer process then reads the files, which is the whole
// point: if a file appeared, the child outlived the parent.
//
// Usage
//   npm run check:paste-exit        (Windows only; exits 0 elsewhere)
//
// Output
//   dogfood/paste-exit-probe.json and one log per variant, plus annotations when run in CI.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPasteScript } from '../dist/utils/pasteHelper.js';
import { createStyle } from './report-style.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const REPORT_FILE = path.join(DOGFOOD_DIRECTORY, 'paste-exit-probe.json');
const TRACE_MARKER = path.join(PLUGIN_ROOT, 'trace.on');
const MODULE_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'dist', 'utils', 'pasteHelper.js')).href;
const RUNTIME_LOG = path.join(DOGFOOD_DIRECTORY, 'runtime.log');

/** Long enough for PowerShell to start and write its first line. */
const SETTLE_MILLISECONDS = 6000;

const style = createStyle();

function readIfPresent (filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function countLines (text) {
  return text === '' ? 0 : text.trimEnd().split('\n').length;
}

/** An emoji that is not the clipboard's, so nothing can be typed into a runner window. */
function chooseEmojiNotOnClipboard () {
  const candidates = ['🧪', '🫧', '🛠️', '🧭'];
  const clipboard = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'], {
    encoding: 'utf8',
    timeout: 10000
  });
  const current = typeof clipboard.stdout === 'string' ? clipboard.stdout.trim() : '';

  return candidates.find((candidate) => candidate !== current) ?? candidates[0];
}

/**
 * Runs one short-lived node process that spawns its variant and exits immediately.
 *
 * The inline script is deliberately tiny: anything it does after spawning could keep it
 * alive, and staying alive is exactly what we are trying to rule out.
 */
function runShortLivedParent (inlineScript, childArguments = []) {
  return new Promise((resolve) => {
    // With `-e`, process.argv is [node, ...childArguments] - no script path to skip.
    const parent = spawn(process.execPath, ['--input-type=module', '-e', inlineScript, ...childArguments], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stderr = '';
    parent.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    parent.on('exit', (code) => resolve({ parentExitCode: code, parentStderr: stderr.trim().slice(0, 500) }));
  });
}

async function probeOnWindows () {
  fs.mkdirSync(DOGFOOD_DIRECTORY, { recursive: true });

  const emoji = chooseEmojiNotOnClipboard();
  const createdTraceMarker = !fs.existsSync(TRACE_MARKER);
  if (createdTraceMarker) {
    fs.writeFileSync(TRACE_MARKER, '');
  }

  const nodeMarker = path.join(DOGFOOD_DIRECTORY, 'exit-probe-node-marker.txt');
  const shimLog = path.join(DOGFOOD_DIRECTORY, 'exit-probe-shim.log');
  const shimScriptPath = path.join(DOGFOOD_DIRECTORY, 'exit-probe-shim.ps1');
  const launcherScriptPath = path.join(DOGFOOD_DIRECTORY, 'exit-probe-launcher.mjs');

  for (const file of [nodeMarker, shimLog]) {
    fs.rmSync(file, { force: true });
  }

  fs.writeFileSync(shimScriptPath, buildPasteScript(emoji, shimLog));

  // The launcher imports the production module, so it writes to the plugin's own trace.
  fs.writeFileSync(launcherScriptPath, [
    `import { spawnPasteHelper } from '${MODULE_URL}';`,
    `spawnPasteHelper('${emoji}');`,
    'setTimeout(() => process.exit(0), 4000);',
    ''
  ].join('\n'));

  /**
   * Runs one variant and measures it.
   *
   * Variants that go through `spawnPasteHelper` write to the plugin's trace, not to a file
   * of their own, so they are measured as a line-count delta around the run. Variants with
   * their own script log are measured directly. Measuring `plain` against a file nobody
   * writes was a real bug in the first version of this probe: it reported "nothing
   * survived" for a run that had actually worked.
   */
  const runVariant = async ({ name, inlineScript, arguments: childArguments = [], logFile = null }) => {
    const traceBefore = countLines(readIfPresent(RUNTIME_LOG));
    const outcome = await runShortLivedParent(inlineScript, childArguments);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));

    const lineCount = logFile === null
      ? countLines(readIfPresent(RUNTIME_LOG)) - traceBefore
      : countLines(readIfPresent(logFile));

    return {
      name,
      ...outcome,
      measured: logFile === null ? 'plugin trace delta' : path.relative(PLUGIN_ROOT, logFile),
      lineCount,
      producedOutput: lineCount > 0
    };
  };

  const variants = [];

  // 1. The production path, with the parent dying at once.
  variants.push(await runVariant({
    name: 'plain',
    inlineScript: `import { spawnPasteHelper } from '${MODULE_URL}';` +
      `spawnPasteHelper('${emoji}');` +
      'process.exit(0);'
  }));

  // 2. A child that is not PowerShell and not our code: does anything survive at all?
  variants.push(await runVariant({
    name: 'node-marker',
    inlineScript: 'import { spawn } from \'node:child_process\';' +
      'const [marker] = process.argv.slice(1);' +
      "const child = spawn(process.execPath, ['-e', \"require('node:fs').writeFileSync(process.argv[1], 'alive')\", marker]," +
      "  { stdio: 'ignore', windowsHide: true });" +
      'child.unref();' +
      'process.exit(0);',
    arguments: [nodeMarker],
    logFile: nodeMarker
  }));

  // 3. PowerShell handed to a fresh process tree by `cmd /c start /b`.
  variants.push(await runVariant({
    name: 'start-shim',
    inlineScript: 'import { spawn } from \'node:child_process\';' +
      'const [, scriptPath] = process.argv;' +
      "const child = spawn('cmd.exe', ['/c', 'start', '', '/b', 'powershell.exe', '-NoProfile', '-NonInteractive', '-File', scriptPath]," +
      "  { stdio: 'ignore', windowsHide: true });" +
      'child.unref();' +
      'process.exit(0);',
    arguments: [shimScriptPath],
    logFile: shimLog
  }));

  // 4. A detached node launcher: it survives, and *it* starts PowerShell the normal way.
  variants.push(await runVariant({
    name: 'launcher',
    inlineScript: 'import { spawn } from \'node:child_process\';' +
      'const [, scriptPath] = process.argv;' +
      "const launcher = spawn(process.execPath, ['--input-type=module', scriptPath]," +
      "  { stdio: 'ignore', windowsHide: true, detached: true });" +
      'launcher.unref();' +
      'process.exit(0);',
    arguments: [launcherScriptPath]
  }));

  if (createdTraceMarker) {
    fs.rmSync(TRACE_MARKER, { force: true });
  }

  return { emoji, variants };
}

function report (result) {
  for (const variant of result.variants) {
    const ok = variant.producedOutput;

    console.log(style.finding(
      ok ? 'ok' : 'fail',
      `${variant.name}: parent exit=${variant.parentExitCode} -> ${ok ? `${variant.lineCount} line(s) written` : 'nothing written'}`
    ));

    if (variant.parentStderr !== '') {
      console.log(`    parent stderr: ${variant.parentStderr.split('\n')[0]}`);
    }
  }

  const survivors = result.variants.filter((variant) => variant.producedOutput).map((variant) => variant.name);

  console.log(style.finding(
    survivors.length === 0 ? 'fail' : 'info',
    survivors.length === 0
      ? 'no child survived the parent exit: something is tearing down the process tree'
      : `children survived as: ${survivors.join(', ')}`
  ));
}

function annotate (result) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return;
  }

  for (const variant of result.variants) {
    console.log(`::warning title=exit probe ${variant.name}::` +
      `lines=${variant.lineCount} parentExit=${variant.parentExitCode} ` +
      `survived=${variant.producedOutput}`);
  }
}

async function main () {
  if (process.platform !== 'win32') {
    console.log(style.finding('skip', `paste exit probe needs Windows; this is ${process.platform}`));
    return;
  }

  const result = await probeOnWindows();
  fs.writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2) + '\n');
  report(result);
  annotate(result);
  console.log(style.finding('info', `wrote ${path.relative(PLUGIN_ROOT, REPORT_FILE)}`));
  console.log(style.finding('info', `module under test: ${fileURLToPath(MODULE_URL)}`));
}

await main();
