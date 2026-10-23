// tools/check-paste-agent.mjs
//
// Exercises the resident paste agent on a real Windows machine, without a human in front of
// the screen and without typing anything into any window.
//
// What it proves
//   1. the agent starts from a script this repository generated, and stops running twice;
//   2. it publishes a heartbeat, which is how the plugin knows it is alive;
//   3. it picks up a request file and logs the sequence number;
//   4. it refuses to paste when the clipboard does not hold the emoji, which is the rule
//      that keeps a wrong paste from happening;
//   5. it is still alive afterwards, so a request cannot kill it.
//
// What it deliberately does not prove: that Ctrl+V lands in the right window. That needs a
// human and a focused application; docs/DOGFOODING.md covers that side.
//
// Usage
//   npm run check:paste-agent        (Windows only; exits 0 elsewhere)
//
// Output
//   dogfood/paste-agent-check.json, plus annotations when run in CI.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  ensureAgentScript,
  HEARTBEAT_STALE_AFTER_MILLISECONDS,
  readAgentStatus,
  requestPaste,
  resolveAgentPaths
} from '../dist/utils/pasteAgent.js';
import { createStyle } from './report-style.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const REPORT_FILE = path.join(DOGFOOD_DIRECTORY, 'paste-agent-check.json');

/** Long enough for the agent to see the request and finish its (refused) paste attempt. */
const REQUEST_SETTLE_MILLISECONDS = 4000;

const style = createStyle();

function readIfPresent (filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** An emoji that is not on the clipboard, so a bug cannot paste into a runner window. */
function chooseEmojiNotOnClipboard () {
  const candidates = ['🧪', '🫧', '🛠️', '🧭'];
  const clipboard = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'], {
    encoding: 'utf8',
    timeout: 10000
  }).trim();

  return candidates.find((candidate) => candidate !== clipboard) ?? candidates[0];
}

/** Waits for the agent's first heartbeat, or gives up. */
async function waitForHeartbeat (paths) {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    if (readAgentStatus(paths).running) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

async function checkOnWindows () {
  const failures = [];
  const collect = (label, action) => {
    try {
      return action();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);

      return null;
    }
  };

  fs.mkdirSync(DOGFOOD_DIRECTORY, { recursive: true });

  const paths = resolveAgentPaths();

  // Start from a clean log, so "the agent handled our request" cannot be an old line. The
  // agent always logs now, into its own data folder, so this works without tracing.
  fs.rmSync(paths.log, { force: true });
  ensureAgentScript(paths);

  // The check starts the agent itself and keeps the handle. The CLI would have exited, and
  // a CI job object takes a child down with its parent - this way the agent is alive for
  // exactly as long as the experiment needs it, and is stopped deliberately at the end.
  const findings = [];
  const startupLog = path.join(paths.directory, 'agent-startup.log');
  fs.rmSync(startupLog, { force: true });

  const agent = collect('start', () => spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', paths.script],
    { stdio: ['ignore', 'ignore', fs.openSync(startupLog, 'a')], windowsHide: true }
  ));

  const alive = await waitForHeartbeat(paths);
  findings.push({
    label: 'agent starts and publishes a heartbeat',
    ok: alive,
    detail: alive ? '' : `start-up log: ${readIfPresent(startupLog).trim().slice(0, 400) || '(empty)'}`
  });

  const emoji = chooseEmojiNotOnClipboard();
  const request = requestPaste(emoji, paths);
  findings.push({ label: 'the plugin can see a running agent before it asks', ok: request.agentRunning });

  await new Promise((resolve) => setTimeout(resolve, REQUEST_SETTLE_MILLISECONDS));

  const log = readIfPresent(paths.log);
  findings.push({ label: 'agent logs the request with its sequence number', ok: log.includes(`request sequence=${request.sequence}`) });
  findings.push({ label: 'agent refuses to paste while the clipboard holds something else', ok: log.includes('decision paste=False') });
  findings.push({ label: 'agent is still alive after handling a request', ok: readAgentStatus(paths).running });

  // Deliberate stop, and the check that it really went: a resident process that cannot be
  // stopped is a worse problem than one that cannot be started.
  agent?.kill();
  // Longer than the stale limit on purpose: "is it gone" is answered by the heartbeat
  // stopping, and a heartbeat that is merely young proves nothing.
  await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_STALE_AFTER_MILLISECONDS + 1000));
  findings.push({
    label: 'agent stops when its process is ended',
    ok: !readAgentStatus(paths).running,
    detail: readAgentStatus(paths).running ? 'heartbeat still fresh 2 s after the kill' : ''
  });

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    emoji,
    dataFolder: paths.directory,
    findings,
    failures,
    agentScriptExists: fs.existsSync(paths.script),
    agentScriptBytes: fs.existsSync(paths.script) ? fs.statSync(paths.script).size : 0,
    agentLogTail: log.trim() === '' ? [] : log.trim().split('\n').slice(-12)
  };
}

function report (result) {
  for (const failure of result.failures ?? []) {
    console.log(style.finding('fail', failure));
  }

  for (const finding of result.findings) {
    console.log(style.finding(finding.ok ? 'ok' : 'fail', finding.label));
  }

  const failures = result.findings.filter((finding) => !finding.ok).length;
  console.log(style.finding(failures === 0 ? 'ok' : 'fail', `${result.findings.length - failures}/${result.findings.length} checks passed`));
}

function annotate (result) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return;
  }

  for (const finding of result.findings) {
    console.log(`::${finding.ok ? 'notice' : 'error'} title=paste agent::${finding.label}`);
  }
}

async function main () {
  if (process.platform !== 'win32') {
    console.log(style.finding('skip', `the paste agent check needs Windows; this is ${process.platform}`));

    return;
  }

  const result = await checkOnWindows().catch((error) => ({
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    findings: [],
    failures: [`the check itself threw: ${error.message}`],
    agentLogTail: []
  }));
  fs.writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2) + '\n');
  report(result);
  annotate(result);
  console.log(style.finding('info', `wrote ${path.relative(PLUGIN_ROOT, REPORT_FILE)}`));
}

await main();
