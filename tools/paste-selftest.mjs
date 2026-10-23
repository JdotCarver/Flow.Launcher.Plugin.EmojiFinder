// tools/paste-selftest.mjs
//
// Isolates the paste mechanism from Flow Launcher: copies an emoji, waits while you click
// into Notepad, sends Ctrl+V, and records what happened.
//
// Usage
//   npm run paste:selftest                 # 5 second countdown
//   npm run paste:selftest -- --delay 8
//   npm run paste:selftest -- --emoji ❤️
//
// Writes dogfood/selftest.json and dogfood/selftest.log, both committable.
//
// Read this before blaming Flow: if the emoji does not appear in Notepad here, then the
// injection mechanism itself does not work on this machine, and no amount of timing
// work inside the plugin will change that.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const SCRIPT = path.join(PLUGIN_ROOT, 'tools', 'paste-selftest.ps1');
const RESULT_FILE = path.join(DOGFOOD_DIRECTORY, 'selftest.json');
const LOG_FILE = path.join(DOGFOOD_DIRECTORY, 'selftest.log');

function argument (name, fallback) {
  const index = process.argv.indexOf(name);

  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.platform !== 'win32') {
  console.error('paste:selftest is Windows-only (it needs PowerShell, a clipboard and SendKeys).');
  process.exit(1);
}

fs.mkdirSync(DOGFOOD_DIRECTORY, { recursive: true });
fs.rmSync(RESULT_FILE, { force: true });

const result = spawnSync(
  'powershell.exe',
  [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-Emoji', argument('--emoji', '🙈'),
    '-DelaySeconds', argument('--delay', '5'),
    '-OutFile', RESULT_FILE
  ],
  { stdio: 'inherit', windowsHide: false }
);

const report = readJson(RESULT_FILE);

if (report !== null) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(report, null, 2) + '\n');

  console.log('');
  console.log(`  target window: ${report.focusedAfter?.title ?? 'unknown'} [${report.focusedAfter?.className ?? '?'}]`);
  console.log(`  clipboard round-trip: ${report.clipboardOk ? 'ok' : 'MISMATCH'}`);
  console.log(`  SendKeys sent: ${report.sendKeysSent}`);

  if (report.error !== '') {
    console.log(`  error: ${report.error}`);
  }

  if ((report.focusedAfter?.title ?? '') === '') {
    console.log('\n  No window had focus when the key was sent. Run again and click into Notepad during the countdown.');
  } else if ((report.focusedAfter?.className ?? '').toLowerCase().includes('console')) {
    console.log('\n  Focus never left the terminal. Run again and click into Notepad during the countdown.');
  }

  console.log('\n  commit dogfood/selftest.log with your next message.');
} else {
  console.error('the self-test did not produce a report (see the PowerShell output above)');
}

process.exitCode = report === null ? 1 : exitCodeFor(result.status);

function exitCodeFor (status) {
  return typeof status === 'number' ? status : 1;
}

function readJson (filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}
