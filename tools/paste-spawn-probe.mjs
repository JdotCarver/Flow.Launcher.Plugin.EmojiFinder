// tools/paste-spawn-probe.mjs
//
// Answers one question: why does the paste helper die when *our plugin* starts it, when
// the very same script runs fine when started by hand?
//
// The traced failure is specific. Flow's run recorded `paste:spawn ... started:true,
// pid:3772` and then nothing at all - no `start pid=`, no `poll`, no `decision`. The
// script's first statement is a trace write, so PowerShell never executed line 1.
// `tools/check-paste-helper.mjs` proves the script itself is valid by running it
// head-on, so what differs is the *spawning*: argv, stdio, detachment, window flags, or
// the environment Flow hands down.
//
// How it isolates the difference
//   Variant A runs the production function, `spawnPasteHelper()`, unchanged - the case
//   that fails in Flow. It returns before the child finishes, exactly like in Flow, so
//   this probe then waits and reads the files the child should have written.
//
//   Variants B-F spawn the same script while toggling one property at a time, with
//   stderr piped back to us so PowerShell's own complaint is captured instead of lost.
//   Whichever variant starts writing trace lines names the culprit:
//
//     plugin          production argv and options (the failing baseline)
//     no-window-style -WindowStyle Hidden removed
//     no-hide         windowsHide: false
//     attached        detached: false
//     file            -File <script> instead of -EncodedCommand
//
// Nothing is typed into any window: the helper only sends Ctrl+V when the clipboard
// holds the emoji it was given, so the probe picks an emoji that is *not* on the
// clipboard (see chooseEmojiNotOnClipboard).
//
// Usage
//   npm run check:paste-spawn        (Windows only; exits 0 elsewhere)
//
// Output
//   dogfood/paste-spawn-probe.json   machine-readable, one entry per variant
//   dogfood/probe-<variant>.log      what each variant's helper wrote
//   console                          one coloured line per variant

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildPasteScript, encodePowerShellCommand, spawnPasteHelper } from '../dist/utils/pasteHelper.js';
import { createStyle } from './report-style.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const REPORT_FILE = path.join(DOGFOOD_DIRECTORY, 'paste-spawn-probe.json');
const PRODUCTION_TRACE = path.join(DOGFOOD_DIRECTORY, 'runtime.log');
const PRODUCTION_ERRORS = path.join(DOGFOOD_DIRECTORY, 'helper-stderr.log');
const TRACE_MARKER = path.join(PLUGIN_ROOT, 'trace.on');

/** Long enough for PowerShell to start and write its first line, short enough to wait. */
const SETTLE_MILLISECONDS = 6000;

/** PowerShell's stderr is kept short: one message is normally the whole story. */
const MAXIMUM_CAPTURED_CHARACTERS = 2000;

const style = createStyle();

/**
 * Picks an emoji that is not on the clipboard, so a helper that *does* start cannot
 * paste anything into whatever window the runner has in front.
 */
function chooseEmojiNotOnClipboard () {
  const candidates = ['🧪', '🫧', '🛠️', '🧭'];

  const clipboard = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'], {
    encoding: 'utf8',
    timeout: 10000
  });
  const current = typeof clipboard.stdout === 'string' ? clipboard.stdout.trim() : '';

  return candidates.find((candidate) => candidate !== current) ?? candidates[0];
}

/** Reads a file as text, or '' when it does not exist (which is itself the finding). */
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

/**
 * Spawns the helper script with a variant's options and waits for it to exit.
 *
 * @returns Every fact needed to tell "PowerShell refused to run" apart from "PowerShell
 * ran and our script decided not to paste": exit code, signal, how long it lived, its
 * stderr, and the trace lines it wrote.
 */
function runVariant ({ name, arguments: helperArguments, spawnOptions, logPath }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let capturedError = '';
    let capturedOutput = '';
    let settled = false;

    const child = spawn('powershell.exe', helperArguments, {
      ...spawnOptions,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout?.on('data', (chunk) => {
      capturedOutput += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      capturedError += String(chunk);
    });

    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;

      resolve({
        name,
        spawned: typeof child.pid === 'number',
        pid: child.pid ?? null,
        ...outcome,
        durationMs: Date.now() - startedAt,
        stdout: capturedOutput.slice(0, MAXIMUM_CAPTURED_CHARACTERS),
        stderr: capturedError.slice(0, MAXIMUM_CAPTURED_CHARACTERS),
        traceLines: countLines(readIfPresent(logPath))
      });
    };

    child.on('error', (error) => finish({ exitCode: null, signal: null, spawnError: error.message }));
    child.on('exit', (code, signal) => finish({ exitCode: code, signal }));

    // A helper that is still polling has not failed yet; kill it so the probe stays short.
    setTimeout(() => {
      if (!settled) {
        child.kill();
        finish({ exitCode: null, signal: 'still-running', spawnError: null });
      }
    }, SETTLE_MILLISECONDS);
  });
}

/** The argv and options used by src/utils/pasteHelper.ts, copied deliberately. */
function productionArguments (script) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-EncodedCommand', encodePowerShellCommand(script)
  ];
}

async function probeOnWindows () {
  fs.mkdirSync(DOGFOOD_DIRECTORY, { recursive: true });

  const emoji = chooseEmojiNotOnClipboard();
  const variants = [];
  const productionStartedAt = Date.now();

  // A: the failing case. spawnPasteHelper returns immediately by design, so the probe
  // waits afterwards and reads what the child managed to write.
  const createdTraceMarker = !fs.existsSync(TRACE_MARKER);
  if (createdTraceMarker) {
    fs.writeFileSync(TRACE_MARKER, '');
  }
  const productionTraceBefore = countLines(readIfPresent(PRODUCTION_TRACE));
  const productionErrorsBefore = readIfPresent(PRODUCTION_ERRORS).length;
  const productionStart = spawnPasteHelper(emoji);

  // B-F: the same script with one property changed at a time.
  const definitions = [
    {
      name: 'plugin',
      spawnOptions: { detached: true, windowsHide: true },
      buildArguments: productionArguments
    },
    {
      name: 'no-window-style',
      spawnOptions: { detached: true, windowsHide: true },
      buildArguments: (script) => [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand', encodePowerShellCommand(script)
      ]
    },
    {
      name: 'no-hide',
      spawnOptions: { detached: true, windowsHide: false },
      buildArguments: productionArguments
    },
    {
      name: 'attached',
      spawnOptions: { detached: false, windowsHide: true },
      buildArguments: productionArguments
    },
    {
      name: 'file',
      spawnOptions: { detached: true, windowsHide: true },
      buildArguments: () => ['-NoProfile', '-NonInteractive', '-File', path.join(DOGFOOD_DIRECTORY, 'paste-spawn-probe.ps1')]
    }
  ];

  for (const definition of definitions) {
    const logPath = path.join(DOGFOOD_DIRECTORY, `probe-${definition.name}.log`);
    fs.rmSync(logPath, { force: true });

    const script = buildPasteScript(emoji, logPath);
    fs.writeFileSync(path.join(DOGFOOD_DIRECTORY, 'paste-spawn-probe.ps1'), script);

    variants.push(await runVariant({
      name: definition.name,
      arguments: definition.buildArguments(script),
      spawnOptions: definition.spawnOptions,
      logPath
    }));
  }

  // Give the production child the same grace period, then read its files.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));

  const productionTrace = readIfPresent(PRODUCTION_TRACE);
  const productionErrors = readIfPresent(PRODUCTION_ERRORS);

  if (createdTraceMarker) {
    fs.rmSync(TRACE_MARKER, { force: true });
  }

  return {
    emoji,
    production: {
      ...productionStart,
      newTraceLines: countLines(productionTrace) - productionTraceBefore,
      traceWrittenAfterStart: countLines(productionTrace) > productionTraceBefore,
      helperStderrGrew: productionErrors.length > productionErrorsBefore,
      helperStderr: productionErrors.slice(-MAXIMUM_CAPTURED_CHARACTERS),
      settledInMs: Date.now() - productionStartedAt
    },
    variants
  };
}

/** Prints one line per variant, then names the first that managed to write a trace line. */
function report (result) {
  const { production, variants } = result;

  console.log(style.finding(
    production.traceWrittenAfterStart ? 'ok' : 'fail',
    `production spawnPasteHelper: started=${production.started} pid=${production.pid ?? '-'} ` +
      `trace lines written=${production.newTraceLines}`
  ));

  if (production.helperStderr.trim() !== '') {
    console.log(style.finding('warn', 'helper stderr was captured:'));
    console.log(production.helperStderr.trim().split('\n').map((line) => `    ${line}`).join('\n'));
  }

  for (const variant of variants) {
    const started = variant.traceLines > 0;
    const detail = started
      ? 'ran and wrote trace lines'
      : `exit=${variant.exitCode ?? '-'} signal=${variant.signal ?? '-'}` +
        (variant.stderr.trim() === '' ? '' : ` stderr=${variant.stderr.trim().split('\n')[0]}`);

    console.log(style.finding(started ? 'ok' : 'warn', `${variant.name}: ${detail}`));
  }

  const firstWorking = variants.find((variant) => variant.traceLines > 0);
  if (firstWorking && firstWorking.name !== 'plugin') {
    console.log(style.finding('info', `the script runs when '${firstWorking.name}' is used - that flags the cause`));
  } else if (!firstWorking) {
    console.log(style.finding('fail', 'no variant wrote a trace line - suspect the environment, not the arguments'));
  } else {
    console.log(style.finding('warn', 'every variant works here, so Flow itself is killing the child'));
  }
}

async function main () {
  if (process.platform !== 'win32') {
    console.log(style.finding('skip', `paste spawn probe needs Windows; this is ${process.platform}`));
    return;
  }

  const result = await probeOnWindows();
  fs.writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2) + '\n');
  report(result);
  console.log(style.finding('info', `wrote ${path.relative(PLUGIN_ROOT, REPORT_FILE)}`));
}

await main();
