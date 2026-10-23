// tools/paste-agent.mjs
//
// Human (and CI) controls for the resident paste agent.
//
// The agent is the process that presses Ctrl+V. It has to outlive the Flow Launcher plugin
// process, so it is never started from inside the plugin - it is started here, by the
// installer, and at login from the Startup folder.
//
// Usage
//   npm run agent -- --status            # is it running, and how old is its heartbeat?
//   npm run agent -- --start             # start it now (detached; survives this terminal)
//   npm run agent -- --stop              # stop it
//   npm run agent -- --install-startup   # add the Startup shortcut, so it returns at login
//   npm run agent -- --remove-startup    # remove that shortcut again
//
// Works identically for an installed and a portable Flow Launcher: nothing here looks at
// where Flow Launcher lives. See docs/PASTE_AGENT.md.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  ensureAgentScript,
  readAgentStatus,
  resolveAgentPaths
} from '../dist/utils/pasteAgent.js';
import { createStyle } from './report-style.mjs';

const style = createStyle();

/** The name of the shortcut in the user's Startup folder. */
const STARTUP_SHORTCUT_NAME = 'Flow Launcher Emoji Finder paste agent.lnk';

/** How long to wait for the agent's first heartbeat after starting it. */
const START_WAIT_MILLISECONDS = 8000;

/**
 * Where the agent's own start-up errors go.
 *
 * `-File` is subject to the machine's execution policy, so a freshly generated script in
 * %LOCALAPPDATA% can be refused before it runs a single line, and with no console and
 * stdio ignored that refusal is invisible. Hence -ExecutionPolicy Bypass (it affects this
 * process only) and this file.
 */
const STARTUP_LOG_NAME = 'agent-startup.log';

const paths = resolveAgentPaths();

function agentPid () {
  try {
    return Number(fs.readFileSync(`${paths.directory}\\agent.pid`, 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

function isProcessAlive (pid) {
  if (pid === null) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function reportStatus () {
  const status = readAgentStatus(paths);
  const pid = agentPid();

  if (status.running) {
    console.log(style.finding('ok', `paste agent is running (pid ${pid ?? 'unknown'}, heartbeat ${status.heartbeatAgeMilliseconds} ms old)`));
  } else {
    console.log(style.finding('warn', 'paste agent is not running: paste falls back to copying only'));
  }

  console.log(style.finding('info', `data folder: ${paths.directory}`));

  return status.running;
}

/** Starts the agent as a detached process, then waits for it to say it is alive. */
async function startAgent () {
  if (readAgentStatus(paths).running) {
    console.log(style.finding('info', 'paste agent is already running'));

    return true;
  }

  const scriptPath = ensureAgentScript(paths);
  const startupLog = path.join(paths.directory, STARTUP_LOG_NAME);

  fs.rmSync(startupLog, { force: true });
  const errorStream = fs.openSync(startupLog, 'a');

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
    // NOT detached: on Windows libuv turns that into DETACHED_PROCESS, PowerShell gets no
    // console, and it starts, exits 0 and runs none of the script. That exact mistake cost
    // this feature a day. `unref()` is what lets this CLI exit while the agent keeps going.
    { stdio: ['ignore', 'ignore', errorStream], windowsHide: true }
  );
  child.unref();
  child.on('spawn', () => fs.closeSync(errorStream));

  const deadline = Date.now() + START_WAIT_MILLISECONDS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));

    if (readAgentStatus(paths).running) {
      console.log(style.finding('ok', `paste agent started (pid ${agentPid() ?? 'unknown'})`));

      return true;
    }
  }

  console.log(style.finding('fail', 'the paste agent did not produce a heartbeat within 8 s'));

  const startupErrors = fs.existsSync(startupLog) ? fs.readFileSync(startupLog, 'utf8').trim() : '';

  if (startupErrors !== '') {
    console.log(style.finding('warn', `the agent said: ${startupErrors.split('\n').slice(-3).join(' | ')}`));
  } else {
    console.log(style.finding('warn', `no start-up error was written to ${startupLog}`));
  }

  return false;
}

function stopAgent () {
  const pid = agentPid();

  if (pid === null || !isProcessAlive(pid)) {
    console.log(style.finding('info', 'paste agent was not running'));

    return;
  }

  try {
    process.kill(pid);
    console.log(style.finding('ok', `paste agent stopped (pid ${pid})`));
  } catch (error) {
    console.log(style.finding('fail', `could not stop pid ${pid}: ${error.message}`));
  }
}

/**
 * Adds or removes the Startup shortcut.
 *
 * A shortcut rather than a service or a scheduled task: no elevation, no password, and the
 * user can delete it from Explorer like any other. It points at the *generated* script in
 * %LOCALAPPDATA%, not at the plugin folder, so reinstalling or moving the plugin (portable
 * users included) does not break it.
 */
function configureStartup (shouldInstall) {
  const scriptPath = ensureAgentScript(paths);
  const command = [
    '$startup = [Environment]::GetFolderPath(\'Startup\');',
    `$shortcutPath = Join-Path $startup '${STARTUP_SHORTCUT_NAME}';`,
    shouldInstall
      ? 'if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force };' +
        '$shell = New-Object -ComObject WScript.Shell;' +
        '$shortcut = $shell.CreateShortcut($shortcutPath);' +
        '$shortcut.TargetPath = (Get-Command powershell.exe).Source;' +
        `$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"';` +
        '$shortcut.WindowStyle = 7;' +
        '$shortcut.Description = \'Keeps paste-at-cursor available for the Flow Launcher emoji plugin\';' +
        '$shortcut.Save();' +
        'Write-Output $shortcutPath'
      : 'if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force; Write-Output $shortcutPath }'
  ].join(' ');

  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 20000
    }).trim();

    console.log(style.finding('ok', `${shouldInstall ? 'startup shortcut installed' : 'startup shortcut removed'}: ${output}`));
  } catch (error) {
    console.log(style.finding('fail', `could not change the startup shortcut: ${error.message}`));
    process.exitCode = 1;
  }
}

async function main () {
  const arguments_ = process.argv.slice(2);

  if (process.platform !== 'win32') {
    console.log(style.finding('skip', `the paste agent is Windows-only; this is ${process.platform}`));

    return;
  }

  if (arguments_.includes('--status')) {
    process.exitCode = reportStatus() ? 0 : 1;
  } else if (arguments_.includes('--start')) {
    process.exitCode = await startAgent() ? 0 : 1;
  } else if (arguments_.includes('--stop')) {
    stopAgent();
  } else if (arguments_.includes('--install-startup')) {
    configureStartup(true);
  } else if (arguments_.includes('--remove-startup')) {
    configureStartup(false);
  } else {
    console.log('usage: npm run agent -- --status | --start | --stop | --install-startup | --remove-startup');
  }
}

await main();
