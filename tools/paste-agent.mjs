// tools/paste-agent.mjs
//
// Human (and CI) controls for the resident paste agent.
//
// The agent is the process that presses Ctrl+V. It has to outlive the Flow Launcher plugin
// process, so it is started by the installer, at login from the Startup folder, and by the
// plugin itself when it finds no agent (through the same window-less launcher).
//
// Usage
//   npm run agent -- --status            # is it running, and how old is its heartbeat?
//   npm run agent -- --start --host pwsh # start it under PowerShell 7 instead of 5.1
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
  ensureAgentLauncher,
  ensureAgentScript,
  readAgentStatus,
  resolveAgentPaths,
  resolvePowerShellHost
} from '../dist/utils/pasteAgent.js';
import { createStyle } from './report-style.mjs';

const style = createStyle();

/** Name of the one-shot task used to start the agent outside our own process tree. */
const START_TASK_NAME = 'Flow Launcher Emoji Finder paste agent';

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

/**
 * Which PowerShell runs the agent.
 *
 * `--host pwsh|powershell` wins, then `EMOJI_PASTE_AGENT_HOST`, then the shared resolver in
 * src/utils/pasteAgent.ts, which prefers PowerShell 7 when it is installed and falls back to
 * the 5.1 that every Windows machine has. Both hosts are supported and `check:paste-agent`
 * exercises both - their text-encoding defaults differ, and that difference is what silently
 * broke paste once already.
 */
function resolveHost () {
  const index = process.argv.indexOf('--host');
  const requested = index === -1 ? null : process.argv[index + 1];

  if (requested === 'pwsh' || requested === 'powershell') {
    return requested === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
  }

  return resolvePowerShellHost();
}

const POWERSHELL = resolveHost();

/** The launcher: wscript starts the agent with no window at all, then exits. */
function launcherPath () {
  return ensureAgentLauncher(paths, POWERSHELL);
}

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
  console.log(style.finding('info', `host: ${POWERSHELL}`));

  return status.running;
}

/**
 * Starts the agent so that it outlives whatever started it.
 *
 * A process started directly from this CLI is a child of this CLI, and in a CI job (or any
 * launcher that owns a job object) it is killed when the job ends - which is exactly what
 * happened: the installer started the agent, the run finished, and every later paste found
 * `agentRunning: false`.
 *
 * So the agent is started through Explorer instead, by running its Startup shortcut. Explorer
 * is an already-running desktop process that nobody tears down, so the agent becomes its
 * child and survives. If that fails for any reason, fall back to starting it directly.
 *
 * @returns true when the agent answered with a heartbeat.
 */
async function startAgent () {
  if (readAgentStatus(paths).running) {
    console.log(style.finding('info', 'paste agent is already running'));

    return true;
  }

  const scriptPath = ensureAgentScript(paths);
  const launcher = launcherPath();
  const startupLog = path.join(paths.directory, STARTUP_LOG_NAME);

  const launchedThroughTask = launchThroughTaskScheduler(launcher);
  const launched = launchedThroughTask || launchDirectly(launcher, scriptPath, startupLog);

  if (!launched) {
    console.log(style.finding('fail', 'could not start the paste agent at all'));

    return false;
  }

  const deadline = Date.now() + START_WAIT_MILLISECONDS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));

    if (readAgentStatus(paths).running) {
      console.log(style.finding('ok', `paste agent started (pid ${agentPid() ?? 'unknown'}, ${launchedThroughTask ? 'via Task Scheduler' : 'directly'}, host ${POWERSHELL})`));

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

/**
 * Starts the agent through Task Scheduler.
 *
 * This is the reliable way to start a process that must outlive us: the task is created for
 * the current user ("run only when the user is logged on", no password, no elevation) and
 * Task Scheduler creates the process, so it belongs to no job object of ours. Launching the
 * Startup shortcut through Explorer was the previous attempt and it worked intermittently -
 * sometimes Explorer opened the folder instead of running the shortcut.
 */
function launchThroughTaskScheduler (launcher) {
  // The task runs the launcher, not PowerShell: Task Scheduler creates a console window for a
  // console program, and that window is the flash the user sees. wscript has no console.
  const command = `wscript.exe "${launcher}"`;

  try {
    execFileSync('schtasks.exe', [
      '/create',
      '/tn', START_TASK_NAME,
      '/tr', command,
      '/sc', 'once',
      '/st', '23:59',
      '/f'
    ], { encoding: 'utf8', timeout: 20000 });

    execFileSync('schtasks.exe', ['/run', '/tn', START_TASK_NAME], { encoding: 'utf8', timeout: 20000 });

    // The task exists only to hand the process to Task Scheduler once. Removing it keeps the
    // machine free of a scheduled task nobody asked for.
    execFileSync('schtasks.exe', ['/delete', '/tn', START_TASK_NAME, '/f'], { encoding: 'utf8', timeout: 20000 });

    return true;
  } catch (error) {
    console.log(style.finding('warn', `Task Scheduler could not start the agent (${String(error.message).split('\n')[0]})`));

    return false;
  }
}

/**
 * Starts the agent from this process: the launcher first, then PowerShell directly.
 *
 * Neither survives this terminal closing on every machine, which is why Task Scheduler is
 * tried first; both are here so that a machine with Task Scheduler locked down still pastes.
 */
function launchDirectly (launcher, scriptPath, startupLog) {
  try {
    const cooked = spawn('wscript.exe', [launcher], { stdio: 'ignore', windowsHide: true });
    cooked.unref();

    return true;
  } catch {
    // Fall through to PowerShell itself.
  }

  fs.rmSync(startupLog, { force: true });
  const errorStream = fs.openSync(startupLog, 'a');

  try {
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      // NOT detached: on Windows libuv turns that into DETACHED_PROCESS, PowerShell gets no
      // console, and it starts, exits 0 and runs none of the script.
      { stdio: ['ignore', 'ignore', errorStream], windowsHide: true }
    );
    child.unref();
    child.on('spawn', () => fs.closeSync(errorStream));

    return true;
  } catch {
    fs.closeSync(errorStream);

    return false;
  }
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
 * user can delete it from Explorer like any other. It points at the *generated* launcher in
 * %LOCALAPPDATA%, not at the plugin folder, so reinstalling or moving the plugin (portable
 * users included) does not break it. It runs wscript, so logging in shows no console flash.
 */
function configureStartup (shouldInstall) {
  // Returns the shortcut path when it was created, so the caller can launch it.
  ensureAgentScript(paths);
  const launcher = launcherPath();
  const command = [
    '$startup = [Environment]::GetFolderPath(\'Startup\');',
    `$shortcutPath = Join-Path $startup '${STARTUP_SHORTCUT_NAME}';`,
    shouldInstall
      ? 'if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force };' +
        '$shell = New-Object -ComObject WScript.Shell;' +
        '$shortcut = $shell.CreateShortcut($shortcutPath);' +
        '$shortcut.TargetPath = (Get-Command wscript.exe).Source;' +
        `$shortcut.Arguments = '"${launcher}"';` +
        '$shortcut.WindowStyle = 1;' +
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

    return shouldInstall ? output : null;
  } catch (error) {
    console.log(style.finding('fail', `could not change the startup shortcut: ${error.message}`));
    process.exitCode = 1;

    return null;
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
