// tools/check-dogfood.mjs
//
// Reads the committed dogfooding evidence and says what went wrong, in the order the
// paste path can fail. Written because "paste did nothing" has five plausible causes and
// guessing between them wasted a round trip.
//
// Usage
//   npm run dogfood:check
//
// Exit code 0 when everything looks healthy, 1 when a finding needs attention.
//
// Inputs (all written by the maintainer's Windows machine):
//   dogfood/diagnose.json  - npm run diagnose
//   dogfood/runtime.log    - the plugin's trace, from an install packaged with --trace
//   dogfood/agent.log      - the paste agent's own log, copied back by diagnose
//
// Two processes are involved now: the plugin (which returns in milliseconds and is destroyed
// by Flow) and the resident agent (which does the pasting). Each has its own log, and the
// order below follows the path an emoji takes through them.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createStyle } from './report-style.mjs';

const style = createStyle();

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const REPORT_FILE = path.join(PLUGIN_ROOT, 'dogfood', 'diagnose.json');
const RUNTIME_LOG = path.join(PLUGIN_ROOT, 'dogfood', 'runtime.log');
const AGENT_LOG = path.join(PLUGIN_ROOT, 'dogfood', 'agent.log');

const findings = [];
let problems = 0;

const diagnose = readJson(REPORT_FILE);
const traceLines = readTraceLines(RUNTIME_LOG);

if (diagnose === null) {
  finding('skip', `no ${path.relative(PLUGIN_ROOT, REPORT_FILE)} yet: run "npm run diagnose" on the Windows machine and commit dogfood/`);
} else {
  checkEnvironment(diagnose);
}

if (traceLines.length === 0) {
  finding('skip', `no ${path.relative(PLUGIN_ROOT, RUNTIME_LOG)} yet: run "npm run package -- --install --trace", reproduce, then commit dogfood/`);
} else {
  checkPluginTrace(traceLines);
}

const agentLines = readTraceLines(AGENT_LOG);
if (agentLines.length === 0) {
  finding('skip', `no ${path.relative(PLUGIN_ROOT, AGENT_LOG)} yet: the agent has never run on this machine, so nothing could have been pasted`);
} else {
  checkAgentLog(agentLines);
}

printFindings();

// ---------------------------------------------------------------------------

function checkEnvironment (report) {
  const windows = report.windows ?? {};

  if (windows.skipped !== undefined) {
    finding('skip', `environment probes were not run (${windows.skipped})`);
    return;
  }

  const recovered = windows.result ?? parseReportFromNoise(windows.rawStandardOutput ?? '');
  if (recovered === null) {
    finding('fail', 'the PowerShell diagnostic itself failed; the raw output is in dogfood/diagnose.json');
    return;
  }

  if (windows.result === undefined) {
    finding('warn', 'report recovered from noisy stdout: this is from an old probe version, rerun "npm run diagnose" to get a clean one');
  }

  const result = recovered;

  const installed = report.installedPlugin ?? {};
  if (installed.found === true && installed.tracingEnabled === false) {
    finding('fail', 'the installed plugin has no trace.on, so it cannot log anything: run "npm run package -- --install --trace"');
  }

  if (result.winForms?.ok === false) {
    finding('fail', `System.Windows.Forms does not load: ${result.winForms.error}. Clipboard checks and Ctrl+V are impossible.`);
  }

  for (const test of result.clipboard?.tests ?? []) {
    if (test.matches === false) {
      finding('warn', `clipboard round-trip differs: wrote [${test.writtenCodes}] read [${test.readCodes}]. The agent ignores variation selectors, so a difference of only 65038/8205 is harmless; anything else means the wait loop never matches.`);
    }
  }

  if (result.sendKeys?.ok === false) {
    finding('fail', `SendKeys delivered "${result.sendKeys.typed}" instead of "${result.sendKeys.expected}"${result.sendKeys.error ? ` (${result.sendKeys.error})` : ''}. Synthetic input is not working on this machine.`);
  }

  if ((result.flowProcesses ?? []).length === 0) {
    finding('fail', 'no process named Flow.Launcher* found. The agent waits for Get-Process -Name "Flow.Launcher*"; if Flow is named differently, that check must change. Names seen: ' + ((result.flowLikeProcesses ?? []).map(entry => entry.name).join(', ') || 'none'));
  }

  if (result.uiAutomation !== undefined) {
    finding(
      'info',
      result.uiAutomation.ok === true
        ? `UI Automation focus probe works (${result.uiAutomation.milliseconds} ms): the agent can tell when focus left Flow`
        : `UI Automation is unavailable (${result.uiAutomation.error}); the agent falls back to the MainWindowHandle check alone`
    );
  }

  const startup = report.powershellStartup ?? {};
  if (startup.exitCode !== undefined && startup.exitCode !== 0) {
    finding('fail', `PowerShell could not start (exit ${startup.exitCode}): ${startup.standardError || startup.error}`);
  } else if (typeof startup.milliseconds === 'number') {
    finding('info', `PowerShell cold start on this machine: ${startup.milliseconds} ms (that is the pause before the emoji appears)`);
  }

  const addTypeMilliseconds = result.win32?.milliseconds ?? 0;
  if (addTypeMilliseconds > 0) {
    finding('info', `compiling P/Invoke with Add-Type took ${addTypeMilliseconds} ms, which is why the agent uses Get-Process instead`);
  }
}

/** The plugin half: did it receive a paste action, and could it see an agent? */
function checkPluginTrace (lines) {
  const pluginLines = lines.filter(line => line.startsWith('{'));

  if (pluginLines.length === 0) {
    finding('warn', 'the plugin trace contains no plugin events; it was probably written by an older build');

    return;
  }

  const requests = parseEvents(pluginLines, 'paste:request');

  if (requests.length === 0) {
    finding('fail', 'the plugin never received a "paste" action. Flow is still calling "copy": check that the setting is on paste, and that the installed plugin is the one just packaged.');

    return;
  }

  const lastRequest = requests[requests.length - 1];

  if (lastRequest.agentRunning === false) {
    finding('fail', 'the plugin asked for a paste, but no agent was running. Start it with "npm run agent -- --start" (the installer does this, and the Startup shortcut brings it back at login).');

    return;
  }

  finding('pass', `the plugin published a paste request and could see a running agent (sequence ${lastRequest.sequence})`);
}

/**
 * The agent half: did a request arrive, was the emoji read correctly, and what did it decide?
 *
 * The encoding check is the one that matters most in practice: under Windows PowerShell 5.1 a
 * UTF-8 emoji read with the default encoding arrives as its own bytes, the clipboard can never
 * match, and the agent then correctly refuses to paste - which looks like "nothing happened".
 */
function checkAgentLog (lines) {
  const agentLines = lines.filter(line => line.includes('| agent |'));

  if (agentLines.length === 0) {
    finding('fail', 'the agent log has no agent lines: the process is writing somewhere else, or it never started');

    return;
  }

  const startLine = lastMatchingLine(agentLines, 'start pid=');

  if (startLine.includes('start pid=')) {
    const host = /host=(\S+)/.exec(startLine)?.[1] ?? 'unknown host';
    const version = /ps=(\S+)/.exec(startLine)?.[1] ?? 'unknown version';

    finding('info', `the agent is running under ${host} (PowerShell ${version})`);
  }

  if (agentLines.some(line => line.includes('winforms-error'))) {
    finding('fail', 'the agent could not load System.Windows.Forms, so it can neither read the clipboard nor send Ctrl+V');
  }

  if (agentLines.some(line => line.includes('uiautomation-error'))) {
    finding('info', 'the agent could not load UI Automation; it relied on main-window visibility alone');
  }

  const requestLine = lastMatchingLine(agentLines, 'request sequence=');

  if (!requestLine.includes('request sequence=')) {
    finding('warn', 'the agent never saw a request: it started, but no emoji reached it');

    return;
  }

  const targetCodes = /targetCodes=\[([^\]]*)\]/.exec(requestLine)?.[1] ?? '';

  if (targetCodes !== '') {
    const units = targetCodes.split(',').filter(Boolean);

    // A single character that arrives as several low numbers is the classic 5.1 encoding
    // failure. Legitimate emoji are one or two units (surrogate pair), more only for ZWJ
    // sequences, which then look like 8+ units with a 8205 in the middle.
    const looksMangled = units.length >= 3 && !targetCodes.includes('8205') && Number(units[0]) < 256;

    if (looksMangled) {
      finding('fail', `the agent read the emoji as code points [${targetCodes}], which are its UTF-8 bytes: the request file is being decoded with the wrong encoding. This is the bug that made every paste fail silently.`);
    }
  }

  const decision = lastMatchingLine(agentLines, 'decision paste=');

  if (!decision.includes('decision paste=')) {
    finding('warn', 'the agent saw a request but never reached a decision: it was still running when the log was copied, or it crashed mid-loop');

    return;
  }

  if (decision.includes('decision paste=false')) {
    describeWhyNothingWasPasted(agentLines);

    return;
  }

  const sentKeys = lastMatchingLine(agentLines, 'sendkeys sent');

  if (sentKeys.includes('sendkeys-error')) {
    finding('fail', 'SendKeys threw: ' + sentKeys);

    return;
  }

  if (sentKeys.includes('sendkeys sent')) {
    finding('pass', 'the agent pasted: it saw the emoji on the clipboard and sent Ctrl+V');

    if (agentLines.some(line => line.includes('sendkeys-error'))) {
      finding('fail', 'SendKeys threw: ' + lastMatchingLine(agentLines, 'sendkeys-error'));
    }

    finding('info', 'if the emoji did not appear, the keystroke went to a window that is not the one you were typing in (an elevated window, a fullscreen app, or focus that did not return to your editor).');
  }
}

function describeWhyNothingWasPasted (agentLines) {
  const polls = agentLines.filter(line => line.includes('poll '));
  const lastPoll = polls[polls.length - 1] ?? '';

  if (lastPoll.includes('clipboardEmpty=True')) {
    finding('fail', 'the clipboard never received the emoji. Flow did not run the Flow.Launcher.CopyToClipboard request we printed; the trace contains the emoji we sent, so this is a Flow-side dispatch problem.');

    return;
  }

  if (lastPoll.includes('clipboardMatches=False')) {
    finding('warn', 'the clipboard held text that never matched the emoji. The agent logs the clipboard code points on mismatch; compare them with the request line above.');

    return;
  }

  if (lastPoll.includes('flowVisible=True') && lastPoll.includes('flowHasFocus=True')) {
    finding('fail', 'Flow kept both a visible main window and the focus for the whole wait, so the agent refused to type (by design). This is what a Flow window that minimises to the tray without hiding looks like; both signals need work.');

    return;
  }

  if (lastPoll.includes('flowVisible=True')) {
    finding('warn', 'Flow kept a visible main window, but focus had moved away. The agent should have accepted that; check the decision line.');

    return;
  }

  if (lastPoll.includes('clipboardError=[') && !lastPoll.includes('clipboardError=[]')) {
    finding('fail', 'reading the clipboard kept throwing: ' + lastPoll);

    return;
  }

  finding('warn', 'the agent timed out without a state line that explains it: ' + lastPoll);
}

// ---------------------------------------------------------------------------

function parseEvents (lines, event) {
  return lines
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(entry => entry?.event === event);
}

function lastMatchingLine (lines, needle) {
  return lines.filter(line => line.includes(needle)).pop() ?? '';
}

function readTraceLines (filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function readJson (filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * The first version of the Windows probe printed its report on stdout, where a stray
 * `True` corrupted it. Older report files still contain that shape, so recover the JSON
 * object instead of failing on it.
 */
function parseReportFromNoise (rawOutput) {
  const start = String(rawOutput).indexOf('{');
  if (start === -1) return null;

  try {
    return JSON.parse(String(rawOutput).slice(start));
  } catch {
    return null;
  }
}

function finding (kind, message) {
  findings.push({ kind, message });

  if (kind === 'fail') {
    problems++;
  }
}

function printFindings () {
  const order = { fail: 0, warn: 1, pass: 2, info: 3, skip: 4 };

  for (const { kind, message } of [...findings].sort((first, second) => order[first.kind] - order[second.kind])) {
    console.log(style.finding(kind, message));
  }

  console.log(
    problems === 0
      ? `\n${style.green('verdict: nothing broken in the evidence collected so far.')}`
      : `\n${style.red(`verdict: ${problems} blocker(s) found.`)}`
  );

  process.exitCode = problems === 0 ? 0 : 1;
}
