// tools/check-paste-agent.mjs
//
// Exercises the resident paste agent on a real Windows machine, without a human in front of
// the screen and without typing anything into any window.
//
// It runs the whole experiment once per PowerShell host: Windows PowerShell 5.1
// (powershell.exe, present on every Windows machine) and PowerShell 7 (pwsh, only when the
// user installed it). Their text-encoding defaults differ, and that difference is exactly
// what silently broke paste once: under 5.1 the request file's UTF-8 emoji arrived as four
// meaningless characters and the clipboard could never match. Running both hosts is how that
// class of bug is caught before a user finds it.
//
// The agent runs in a temporary folder, never the user's. Proving the agent works used to
// stop and restart the real one, so paste on this machine failed for about a minute on every
// Windows run - indistinguishable from a bug in the feature, and reported as one.
//
// What it proves, per host
//   1. the agent starts from a script this repository generated;
//   2. it publishes a heartbeat, which is how the plugin knows it is alive;
//   3. it picks up a request file and logs the sequence number;
//   4. the emoji survives the trip through that file with the right code points;
//   5. it refuses to paste when the clipboard does not hold the emoji;
//   6. it refuses to paste while Flow Launcher has focus, even with the right emoji on the
//      clipboard (the bug of 2026-10-27: the keystroke landed in Flow's hidden query box);
//   7. it is still alive afterwards.
//
// What it deliberately does not prove: that Ctrl+V lands in the right window. That needs a
// human and a focused application; docs/DOGFOODING.md covers that side.
//
// Usage
//   npm run check:paste-agent        (Windows only; exits 0 elsewhere)
//
// Output
//   dogfood/paste-agent-check.json, plus annotations when run in CI, and a non-zero exit
//   status if any assertion failed under any installed host.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  AGENT_DIRECTORY_VARIABLE,
  AGENT_LAUNCHER_FILE_NAME,
  FLOW_PROCESS_NAME_VARIABLE,
  ensureAgentLauncher,
  ensureAgentScript,
  HEARTBEAT_STALE_AFTER_MILLISECONDS,
  readAgentStatus,
  requestPaste,
  resolveAgentPaths,
  resolvePowerShellHost
} from '../dist/utils/pasteAgent.js';
import { createStyle } from './report-style.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const DOGFOOD_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
const REPORT_FILE = path.join(DOGFOOD_DIRECTORY, 'paste-agent-check.json');

/** Long enough for the agent to see the request and finish its (refused) paste attempt. */
const REQUEST_SETTLE_MILLISECONDS = 4000;

/** Long enough for a cold PowerShell to start on a busy machine. */
const START_WAIT_MILLISECONDS = 15000;

const style = createStyle();

/**
 * The whole run happens in here, so it can never touch the agent the user is relying on.
 * Set before anything resolves the paths: the module reads this variable on every call, and
 * every subprocess started below inherits it.
 */
const AGENT_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-agent-check-'));

process.env[AGENT_DIRECTORY_VARIABLE] = AGENT_DIRECTORY;

function readIfPresent (filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Reads a file from a byte offset.
 *
 * The offset comes from `fs.statSync().size`, so it is a byte count; slicing the decoded string
 * at it would be wrong, because the log is full of emoji and a JavaScript string index counts
 * UTF-16 code units - one emoji is 2 units but 4 bytes. The mismatch quietly cut the first
 * line of every slice in half, which is how the start line became 'start pid=…' with no
 * timestamp and 'art pid=…' for the host after it.
 */
function readFromByteOffset (filePath, offset) {
  try {
    const contents = fs.readFileSync(filePath);

    return contents.subarray(offset).toString('utf8');
  } catch {
    return '';
  }
}

function existingBytes (filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Both hosts when both exist: `pwsh` is an optional install on Windows 10 and 11 alike. */
function availableHosts () {
  const hosts = ['powershell.exe'];

  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    hosts.push('pwsh.exe');
  } catch {
    // Not installed. That is a normal machine, not a problem to report.
  }

  return hosts;
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

/** What the clipboard holds right now, so a check can put it back afterwards. */
function readClipboard () {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], {
      encoding: 'utf8',
      timeout: 10000
    });
  } catch {
    return '';
  }
}

/** Puts text on the clipboard without it being interpreted as a script fragment. */
function writeClipboard (text) {
  const base64 = Buffer.from(text, 'utf8').toString('base64');

  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[System.Windows.Forms.Clipboard]::SetText([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}')))`
  ], { encoding: 'utf8', timeout: 10000 });
}

/** The UTF-16 code units a text editor would show, which is what the agent logs. */
function codePointsOf (text) {
  return [...text.split('')].map((character) => character.charCodeAt(0)).join(',');
}

/**
 * Waits until no agent is running.
 *
 * A heartbeat stays "fresh" for a few seconds after the process dies, so a stop that is not
 * waited for makes the next host's start look successful when nothing started at all. That
 * false positive is how a host can appear green while its agent never ran a single line.
 */
async function waitUntilStopped (paths) {
  const deadline = Date.now() + START_WAIT_MILLISECONDS;

  while (Date.now() < deadline) {
    if (!readAgentStatus(paths).running) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

async function waitForHeartbeat (paths) {
  const deadline = Date.now() + START_WAIT_MILLISECONDS;

  while (Date.now() < deadline) {
    if (readAgentStatus(paths).running) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

/**
 * Runs the full experiment under one host.
 *
 * @returns Findings, plus the raw log lines the assertions were made from.
 */
async function checkHost (host, emoji) {
  const paths = resolveAgentPaths();
  ensureAgentScript(paths);

  const findings = [];
  const startupLog = path.join(paths.directory, `agent-startup-${host.replace('.exe', '')}.log`);

  // A fresh folder per host would be cleaner still, but the paths are fixed for the whole run;
  // what matters is that nothing is running before this host starts.
  const stopped = await waitUntilStopped(paths);
  findings.push({ label: 'no agent is running before this host starts', ok: stopped });

  // After the stop, so nothing the previous host wrote can be mistaken for this host's work.
  const logOffset = existingBytes(paths.log);
  fs.rmSync(startupLog, { force: true });

  let agent = null;
  try {
    agent = spawn(
      host,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', paths.script],
      { stdio: ['ignore', 'ignore', fs.openSync(startupLog, 'a')], windowsHide: true }
    );
  } catch (error) {
    findings.push({ label: 'agent starts', ok: false, detail: error.message });
  }

  const alive = await waitForHeartbeat(paths);
  const startupText = readIfPresent(startupLog).trim().slice(0, 600);

  findings.push({
    label: 'agent starts and publishes a heartbeat',
    ok: alive,
    detail: alive ? '' : `start-up log: ${startupText || '(empty)'}`
  });

  const request = requestPaste(emoji, paths);
  findings.push({ label: 'the plugin can see a running agent before it asks', ok: request.agentRunning });

  await new Promise((resolve) => setTimeout(resolve, REQUEST_SETTLE_MILLISECONDS));

  const log = readFromByteOffset(paths.log, logOffset);
  const expectedCodes = codePointsOf(emoji);

  // First: did this host's process write anything at all? When it did not, its stderr is the
  // only thing that explains why, and it is attached to the finding rather than buried.
  const wroteAnything = log.trim() !== '';
  findings.push({
    label: 'the agent writes its own log',
    ok: wroteAnything,
    detail: wroteAnything ? '' : `start-up log: ${startupText || '(empty)'}`
  });

  // The start line names the host and its version, which is the only way a log from a user's
  // machine can be attributed to one PowerShell without guessing.
  const startLine = log.split(/\r?\n/).find((line) => line.includes('| start ')) ?? '';
  const expectedProcessName = host.replace(/\.exe$/, '');
  findings.push({
    label: `the start line names this host (${expectedProcessName}) and its version`,
    ok: startLine.includes(`host=${expectedProcessName} `) && /ps=\d+\.\d+/.test(startLine),
    detail: startLine.trim() || 'no start line in the log'
  });

  findings.push({ label: 'agent logs the request with its sequence number', ok: log.includes(`request sequence=${request.sequence}`) });
  findings.push({
    label: `emoji survives the request file intact (expected code points ${expectedCodes})`,
    ok: log.includes(`targetCodes=[${expectedCodes}]`),
    detail: log.includes(`targetCodes=[${expectedCodes}]`) ? '' : 'the agent read something other than the emoji that was written: an encoding problem'
  });
  findings.push({ label: 'agent refuses to paste while the clipboard holds something else', ok: log.includes('decision paste=False') });
  findings.push({ label: 'agent is still alive after handling a request', ok: readAgentStatus(paths).running });

  agent?.kill();
  // Longer than the stale limit on purpose: "is it gone" is answered by the heartbeat stopping.
  await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_STALE_AFTER_MILLISECONDS + 1000));
  findings.push({ label: 'agent stops when its process is ended', ok: !readAgentStatus(paths).running });

  return {
    host,
    startLine: startLine.trim() || null,
    findings,
    startupLog: startupText || null,
    logTail: log.trim() === '' ? [] : log.trim().split('\n').slice(-10)
  };
}

/**
 * Proves the focus gate on a real machine.
 *
 * The script is regenerated with `EMOJI_PASTE_AGENT_FLOW_PROCESS=*`, so every process counts
 * as Flow Launcher - including whichever window has focus. The clipboard then holds exactly
 * the emoji that is requested, which is the state the old rule pasted in, and the agent has to
 * refuse: `decision paste=False`.
 *
 * Nothing is typed either way, because a refused paste sends no keystroke. That is what makes
 * this safe to run with a real window focused, unlike a test that proves the positive case.
 */
async function checkFocusGate (emoji) {
  const paths = resolveAgentPaths();
  const findings = [];
  const host = resolvePowerShellHost();
  const clipboardBefore = readClipboard();
  const startupLog = path.join(paths.directory, 'agent-startup-focusgate.log');

  let agent = null;
  try {
    process.env[FLOW_PROCESS_NAME_VARIABLE] = '*';
    ensureAgentScript(paths);

    const stopped = await waitUntilStopped(paths);
    findings.push({ label: 'no agent is running before the focus gate is checked', ok: stopped });

    const logOffset = existingBytes(paths.log);

    try {
      agent = spawn(
        host,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', paths.script],
        { stdio: ['ignore', 'ignore', fs.openSync(startupLog, 'a')], windowsHide: true }
      );
    } catch (error) {
      findings.push({ label: 'the focus gate agent starts', ok: false, detail: error.message });
    }

    findings.push({ label: 'the focus gate agent starts and publishes a heartbeat', ok: await waitForHeartbeat(paths) });

    // The emoji goes on the clipboard *before* the request: the old rule required the clipboard
    // to match, so this is exactly the state that used to paste inside the launcher.
    writeClipboard(emoji);
    requestPaste(emoji, paths);

    await new Promise((resolve) => setTimeout(resolve, REQUEST_SETTLE_MILLISECONDS));

    const log = readFromByteOffset(paths.log, logOffset);

    // One poll line has to report both halves of the condition that used to paste: Flow holding
    // focus and the clipboard holding the emoji. Either half alone proves nothing.
    const sawBothHalves = /poll (?=.*flowHasFocus=True)(?=.*clipboardMatches=True).*/.test(log);
    const refused = log.includes('decision paste=False');

    findings.push({
      label: 'a poll sees Flow holding focus and the clipboard holding the emoji at the same time',
      ok: sawBothHalves,
      detail: sawBothHalves ? '' : 'no poll line reported flowHasFocus=True with clipboardMatches=True: the probe, the process match, or the clipboard write is not working'
    });
    findings.push({
      label: 'agent refuses to paste in that state, which is the bug of 2026-10-27',
      ok: refused,
      detail: refused ? '' : 'the agent pasted into whichever window had focus instead of refusing'
    });

    // The script that will be installed is the one that has to be free of titles, so the
    // assertion is made against it rather than against this run's log.
    const installedScript = readIfPresent(paths.script);
    findings.push({
      label: 'the installed agent names no window title anywhere',
      ok: installedScript !== '' && !installedScript.includes('.Current.Name') && !/\btitle=/.test(installedScript),
      detail: installedScript === '' ? 'no agent script on disk' : 'the agent script reads or logs a window title'
    });
  } finally {
    agent?.kill();
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_STALE_AFTER_MILLISECONDS + 1000));

    // Everything below runs even when an assertion above failed: leaving the wildcard in place
    // would make every later paste in this run refuse, and leaving the emoji on the clipboard
    // would change what the user finds there.
    writeClipboard(clipboardBefore);
    delete process.env[FLOW_PROCESS_NAME_VARIABLE];
    ensureAgentScript(paths);
    fs.rmSync(startupLog, { force: true });
  }

  return { host: `focus gate (${host})`, findings, startLine: null, startupLog: null, logTail: [] };
}

/**
 * Starts the agent the way the plugin does when it finds none: through the window-less
 * launcher.
 *
 * This is the path a user takes after a reboot, so it is the path that has to work. What it
 * cannot prove here is the part that matters most to them - that no window appears - because
 * that needs eyes on the screen; `docs/PASTE_AGENT.md` says how it is done.
 */
async function checkLauncher () {
  const paths = resolveAgentPaths();
  const findings = [];

  ensureAgentScript(paths);
  const host = resolvePowerShellHost();
  const launcher = ensureAgentLauncher(paths, host);

  const stopped = await waitUntilStopped(paths);
  findings.push({ label: 'no agent is running before the launcher is used', ok: stopped });
  findings.push({ label: 'the launcher exists beside the agent script', ok: fs.existsSync(launcher) });

  try {
    const child = spawn('wscript.exe', [launcher], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => { });
    child.unref();
    findings.push({ label: 'the launcher starts without a PowerShell of its own', ok: true });
  } catch (error) {
    findings.push({ label: 'the launcher starts', ok: false, detail: error.message });
  }

  const alive = await waitForHeartbeat(paths);
  findings.push({ label: `the launcher started an agent (host ${host})`, ok: alive });
  findings.push({ label: 'the agent it started is the one this build generates', ok: fs.existsSync(paths.script) });

  return { host: `wscript launcher (${path.basename(AGENT_LAUNCHER_FILE_NAME)})`, findings, startLine: null, startupLog: null, logTail: [] };
}

async function checkOnWindows () {
  fs.mkdirSync(DOGFOOD_DIRECTORY, { recursive: true });

  const emoji = chooseEmojiNotOnClipboard();
  const hosts = availableHosts();
  const results = [];

  try {
    for (const host of hosts) {
      results.push(await checkHost(host, emoji));
    }

    results.push(await checkFocusGate(emoji));
    results.push(await checkLauncher());
  } finally {
    // The user's agent and its files were never touched, so there is nothing to restore. Only
    // the evidence is copied out, by diagnose, before this folder goes.
    fs.rmSync(AGENT_DIRECTORY, { recursive: true, force: true });
  }

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    emoji,
    hosts,
    dataFolder: AGENT_DIRECTORY,
    results
  };
}

function allFindings (report) {
  return report.results.flatMap((result) => result.findings.map((finding) => ({ ...finding, host: result.host })));
}

function report (result) {
  for (const hostResult of result.results) {
    console.log(style.finding('info', `--- ${hostResult.host} ---`));

    for (const finding of hostResult.findings) {
      console.log(style.finding(finding.ok ? 'ok' : 'fail', finding.label));

      if (!finding.ok && finding.detail) {
        console.log(style.finding('warn', `    ${finding.detail}`));
      }
    }
  }

  const findings = allFindings(result);
  const failures = findings.filter((finding) => !finding.ok).length;

  console.log(style.finding(failures === 0 ? 'ok' : 'fail', `${findings.length - failures}/${findings.length} checks passed across ${result.hosts.join(' and ')}`));

  return failures;
}

function annotate (result) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return;
  }

  for (const finding of allFindings(result)) {
    console.log(`::${finding.ok ? 'notice' : 'error'} title=paste agent (${finding.host})::${finding.label}`);
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
    emoji: '',
    hosts: [],
    dataFolder: '',
    results: [{ host: 'check', findings: [{ label: `the check itself threw: ${error.message}`, ok: false }], logTail: [] }]
  }));

  fs.writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2) + '\n');
  const failures = report(result);
  annotate(result);
  console.log(style.finding('info', `wrote ${path.relative(PLUGIN_ROOT, REPORT_FILE)}`));

  // Every host has to pass. A green job that only proves the host the maintainer happens to
  // have installed is exactly the false confidence this check exists to remove.
  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
