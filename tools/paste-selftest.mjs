// tools/paste-selftest.mjs
//
// "Does pasting work on this machine at all?" - answered by the agent, not by Flow.
//
// It counts down while you click into Notepad (or anything else that accepts text), then asks
// the resident paste agent to paste an emoji, and reports what the agent did with it. If the
// emoji does not appear here, the problem is the agent or the machine, not Flow Launcher.
//
// Usage
//   npm run paste:selftest                 # 5 second countdown
//   npm run paste:selftest -- --delay 8
//   npm run paste:selftest -- --emoji ❤️
//
// Writes dogfood/selftest.json, which is committable.
//
// The emoji is put on the clipboard by this script, the same way Flow does it in-process, so
// the agent's clipboard check has something to match. The agent only pastes when the clipboard
// holds exactly the emoji it was asked for.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readAgentStatus, requestPaste, resolveAgentPaths } from '../dist/utils/pasteAgent.js';
import { createStyle } from './report-style.mjs';

const style = createStyle();

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const RESULT_FILE = path.join(DOGFOOD_DIRECTORY, 'selftest.json');

/** How long the agent gets to see the request and paste it. */
const SETTLE_MILLISECONDS = 4000;

function argument (name, fallback) {
  const index = process.argv.indexOf(name);

  return index === -1 ? fallback : process.argv[index + 1];
}

function copyToClipboard (text) {
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Set-Clipboard -Value '${text.replaceAll("'", "''")}'`
  ], { timeout: 15000 });
}

async function countdown (seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    console.log(style.finding('info', `${remaining}… click into the window you want the emoji in`));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main () {
  if (process.platform !== 'win32') {
    console.log(style.finding('skip', `the paste self-test needs Windows; this is ${process.platform}`));

    return;
  }

  const delay = Number(argument('--delay', '5'));
  const emoji = argument('--emoji', '❤️');
  const paths = resolveAgentPaths();
  const status = readAgentStatus(paths);

  if (!status.running) {
    console.log(style.finding('fail', `the paste agent is not running (heartbeat: ${status.heartbeatAgeMilliseconds ?? 'none'}). Start it with: npm run agent -- --start`));

    return;
  }

  console.log(style.finding('info', `agent is running (heartbeat ${status.heartbeatAgeMilliseconds} ms old), pasting ${emoji}`));

  copyToClipboard(emoji);
  await countdown(delay);

  const logBefore = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, 'utf8').length : 0;
  const request = requestPaste(emoji, paths);

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));

  const log = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, 'utf8').slice(logBefore) : '';
  const pasted = log.includes('sendkeys sent') && log.includes('decision paste=True');

  fs.mkdirSync(DOGFOOD_DIRECTORY, { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    emoji,
    sequence: request.sequence,
    pasted,
    agentLogTail: log.trim() === '' ? [] : log.trim().split('\n').slice(-10)
  }, null, 2) + '\n');

  if (pasted) {
    console.log(style.finding('ok', 'the agent sent Ctrl+V. If the emoji did not appear, the keystroke went to a different window than the one you clicked.'));

    return;
  }

  console.log(style.finding('fail', 'the agent did not paste. Its log tail is in ' + path.relative(PLUGIN_ROOT, RESULT_FILE)));
  for (const line of log.trim().split('\n').slice(-5)) {
    console.log(style.finding('warn', `    ${line}`));
  }
}

await main();
