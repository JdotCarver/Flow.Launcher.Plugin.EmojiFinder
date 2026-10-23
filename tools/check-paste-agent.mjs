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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  ensureAgentScript,
  readAgentStatus,
  requestPaste,
  resolveAgentPaths
} from '../dist/utils/pasteAgent.js';
import { createStyle } from './report-style.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const REPORT_FILE = path.join(DOGFOOD_DIRECTORY, 'paste-agent-check.json');
const TRACE_MARKER = path.join(PLUGIN_ROOT, 'trace.on');
const AGENT_LOG = path.join(DOGFOOD_DIRECTORY, 'agent.log');

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

/**
 * Runs the agent CLI and returns its output either way.
 *
 * The first version let a non-zero exit throw, so a failing start produced no report at all
 * and the step looked like a silent no-op. An experiment that cannot report its own failure
 * is not an experiment.
 */
function runCli (flag) {
  try {
    return execFileSync(process.execPath, [path.join('tools', 'paste-agent.mjs'), flag], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const stdout = String(error.stdout ?? '').trim();
    const stderr = String(error.stderr ?? '').trim();

    return `exit ${error.status}: ${stderr || stdout || error.message}`;
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

  const createdTraceMarker = !fs.existsSync(TRACE_MARKER);
  if (createdTraceMarker) {
    fs.writeFileSync(TRACE_MARKER, '');
  }

  // Start from a clean log, so "the agent handled our request" cannot be an old line.
  fs.rmSync(AGENT_LOG, { force: true });

  const paths = resolveAgentPaths();
  ensureAgentScript(paths);

  const findings = [];
  const startedOutput = collect('start', () => runCli('--start')) ?? '';
  const afterStart = readAgentStatus(paths);
  findings.push({ label: 'agent starts and publishes a heartbeat', ok: afterStart.running, detail: startedOutput });

  const emoji = chooseEmojiNotOnClipboard();
  const request = requestPaste(emoji, paths);
  findings.push({ label: 'the plugin can see a running agent before it asks', ok: request.agentRunning });

  await new Promise((resolve) => setTimeout(resolve, REQUEST_SETTLE_MILLISECONDS));

  const log = readIfPresent(AGENT_LOG);
  findings.push({ label: 'agent logs the request with its sequence number', ok: log.includes(`request sequence=${request.sequence}`) });
  findings.push({ label: 'agent refuses to paste while the clipboard holds something else', ok: log.includes('decision paste=False') });
  findings.push({ label: 'agent is still alive after handling a request', ok: readAgentStatus(paths).running });

  const stopOutput = collect('stop', () => runCli('--stop')) ?? '';
  await new Promise((resolve) => setTimeout(resolve, 1500));
  findings.push({ label: 'agent stops on request', ok: !readAgentStatus(paths).running, detail: stopOutput });

  if (createdTraceMarker) {
    fs.rmSync(TRACE_MARKER, { force: true });
  }

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
