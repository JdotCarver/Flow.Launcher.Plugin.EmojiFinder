// tools/doctor.mjs
//
// Answers "why is the plugin not in Flow Launcher?" from the outside, without Flow.
//
// Usage
//   npm run doctor
//
// Writes dogfood/doctor.json (committable) and prints a verdict.
//
// What it checks, and why each one matters. Flow Launcher loads a plugin folder only if
// all of these hold, and it fails silently (a log line, no UI) at every step:
//
//   1. the folder is a DIRECT child of the Plugins folder      (PluginConfig.Parse)
//   2. plugin.json parses, and its Language is allowed         (GetPluginMetadata)
//   3. ExecuteFileName points at a file that EXISTS            (GetPluginMetadata)
//   4. its ID is not already used by another folder            ("Plugin with ID ... already loaded")
//   5. the Node runtime Flow points at still exists            (AbstractPluginEnvironment.Setup)
//
// The first four are checked here by inspection; the fifth by reading Flow's settings.
// Flow's own log lines for this plugin are collected too, because they name the reason.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createStyle } from './report-style.mjs';

const style = createStyle();

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = readJson(path.join(PLUGIN_ROOT, 'plugin.json')) ?? {};

const PLUGIN_ID = MANIFEST.ID ?? '';
const PLUGIN_NAME = MANIFEST.Name ?? '';
const PLUGIN_FOLDER_NAME = 'Flow.Launcher.Plugin.EmojiFinder';

const findings = [];
let blockers = 0;

const dataDirectory = findFlowDataDirectory();

if (dataDirectory === null) {
  finding('skip', 'no Flow Launcher data folder found (looked in %APPDATA%\\FlowLauncher and .\\UserData). Portable install? Then run this from the Flow Launcher folder.');
} else {
  const pluginsDirectory = path.join(dataDirectory, 'Plugins');

  finding('info', `Flow data folder: ${dataDirectory}`);
  inspectPluginsDirectory(pluginsDirectory);
  inspectNodeRuntime(dataDirectory);
  inspectLogs(path.join(dataDirectory, 'Logs'));
  inspectPluginSettings(dataDirectory);
}

printFindings();
writeReport();

// ---------------------------------------------------------------------------
// Plugin folders
// ---------------------------------------------------------------------------

function inspectPluginsDirectory (pluginsDirectory) {
  if (!fs.existsSync(pluginsDirectory)) {
    finding('fail', `Plugins folder missing: ${pluginsDirectory}`);

    return;
  }

  const entries = fs.readdirSync(pluginsDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    // Flow deletes folders that contain this marker; they are not loaded on purpose.
    .filter(entry => !fs.existsSync(path.join(pluginsDirectory, entry.name, 'NeedDelete.txt')));

  finding('info', `${entries.length} plugin folder(s) found`);

  const seenIds = new Map();

  for (const entry of entries) {
    const directory = path.join(pluginsDirectory, entry.name);
    const manifestPath = path.join(directory, 'plugin.json');
    const manifest = readJson(manifestPath);

    if (manifest === null) {
      if (looksLikeThisPlugin(entry.name)) {
        finding('fail', `${entry.name}: no readable plugin.json. Flow ignores this folder.`);
      }

      continue;
    }

    recordDuplicateId(seenIds, manifest, entry.name);
    checkNesting(directory, entry.name);
    checkExecuteFile(directory, manifest, entry.name);
    checkBundledDependencies(directory, manifest, entry.name);
  }

  inspectInstalledCopy(pluginsDirectory);
}

function recordDuplicateId (seenIds, manifest, folderName) {
  const existing = seenIds.get(manifest.ID);

  if (existing === undefined) {
    seenIds.set(manifest.ID, folderName);

    return;
  }

  finding('fail', `duplicate plugin ID ${manifest.ID} in "${existing}" and "${folderName}". Flow loads only the first and logs "Plugin with ID ... already loaded" for the other, so edits to one copy can appear to do nothing. Delete one.`);
}

function checkNesting (directory, folderName) {
  const nested = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(directory, entry.name, 'plugin.json'))
    .filter(candidate => fs.existsSync(candidate));

  if (nested.length > 0) {
    finding('fail', `${folderName} contains another plugin folder (${path.relative(directory, path.dirname(nested[0]))}). Flow scans one level only, so the inner copy never loads.`);
  }
}

function checkExecuteFile (directory, manifest, folderName) {
  const executeFile = String(manifest.ExecuteFileName ?? '').replaceAll('\\', path.sep);
  const resolved = path.resolve(directory, executeFile);

  if (!fs.existsSync(resolved)) {
    finding('fail', `${folderName}: ExecuteFileName "${manifest.ExecuteFileName}" does not exist (looked for ${resolved}). This is the "plugin disappears without a message" case.`);

    return;
  }

  if (looksLikeThisPlugin(folderName)) {
    finding('pass', `${folderName}: manifest OK, entry point present (${manifest.ExecuteFileName})`);
  }
}

/**
 * A built copy needs package.json (for "type": "module") and the emoji data.
 */
function checkBundledDependencies (directory, manifest, folderName) {
  if (!looksLikeThisPlugin(folderName)) {
    return;
  }

  const packageJson = readJson(path.join(directory, 'package.json'));
  if (packageJson === null) {
    finding('fail', `${folderName}: package.json missing. Node cannot load the ESM entry point without "type": "module".`);
  } else if (packageJson.type !== 'module') {
    finding('fail', `${folderName}: package.json does not declare "type": "module", so dist/main.js (ESM) fails to load.`);
  }

  const emojiData = path.join(directory, 'node_modules', 'emojilib', 'dist', 'emoji-en-US.json');
  if (!fs.existsSync(emojiData)) {
    finding('fail', `${folderName}: node_modules/emojilib is missing; every query would throw. Re-run "npm run package -- --install".`);
  }

  finding('info', `${folderName}: tracing ${fs.existsSync(path.join(directory, 'trace.on')) ? 'ON' : 'off'}, trace file ${describeTraceFile(directory)}`);
}

function describeTraceFile (directory) {
  const traceFile = path.join(directory, 'dogfood', 'runtime.log');

  try {
    const stats = fs.statSync(traceFile);

    return `${stats.size} bytes, modified ${stats.mtime.toISOString()}`;
  } catch {
    return 'missing';
  }
}

function inspectInstalledCopy (pluginsDirectory) {
  const installed = path.join(pluginsDirectory, PLUGIN_FOLDER_NAME);

  if (!fs.existsSync(installed)) {
    finding('fail', `this plugin is not installed at ${installed}. Run "npm run package -- --install".`);

    return;
  }

  compareBuildTimes(installed);
}

/**
 * The most common "my change did nothing": the installed copy is older than the build.
 */
function compareBuildTimes (installed) {
  const installedEntry = statOrNull(path.join(installed, 'dist', 'main.js'));
  const repositoryEntry = statOrNull(path.join(PLUGIN_ROOT, 'dist', 'main.js'));

  if (installedEntry === null) {
    finding('fail', 'installed dist/main.js is missing even though the folder exists');

    return;
  }

  if (repositoryEntry !== null && repositoryEntry.mtimeMs > installedEntry.mtimeMs + 1000) {
    finding('fail', `the installed plugin is older than the build in this repository (installed ${installedEntry.mtime.toISOString()}, built ${repositoryEntry.mtime.toISOString()}). Run "npm run package -- --install" and restart Flow Launcher.`);

    return;
  }

  finding('pass', `installed copy matches the build (${installedEntry.mtime.toISOString()})`);
}

// ---------------------------------------------------------------------------
// Runtime and logs
// ---------------------------------------------------------------------------

/**
 * Flow runs JavaScript plugins with a Node it manages itself. If that path is broken,
 * Setup() returns an empty list and EVERY JavaScript plugin disappears.
 */
function inspectNodeRuntime (dataDirectory) {
  const settingsFiles = listJsonFiles(path.join(dataDirectory, 'Settings'));
  const candidate = settingsFiles
    .map(file => ({ file, json: readJson(file) }))
    .map(({ file, json }) => ({ file, nodePath: findKey(json, 'NodeExecutablePath') }))
    .find(entry => entry.nodePath !== undefined && entry.nodePath !== '');

  if (candidate === undefined) {
    finding('warn', 'no NodeExecutablePath in Flow\'s settings; Flow must resolve the runtime itself');

    return;
  }

  if (fs.existsSync(candidate.nodePath)) {
    finding('pass', `Node runtime for plugins exists: ${candidate.nodePath}`);
  } else {
    finding('fail', `the Node runtime Flow points at is missing: ${candidate.nodePath}. Every JavaScript plugin would vanish, not just this one. Flow usually offers to re-download it.`);
  }
}

function findKey (value, key) {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  if (key in value) {
    return value[key];
  }

  for (const nested of Object.values(value)) {
    const found = findKey(nested, key);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/**
 * Flow logs a line at every step where it gives up on a plugin. Those lines are the
 * closest thing to a stack trace for "it just is not there".
 */
function inspectLogs (logsDirectory) {
  const logFiles = listFiles(looksLikeLogFile, logsDirectory)
    .map(file => ({ file, modified: statOrNull(file)?.mtimeMs ?? 0 }))
    .sort((first, second) => second.modified - first.modified)
    .slice(0, 5);

  if (logFiles.length === 0) {
    finding('warn', `no Flow Launcher logs found in ${logsDirectory}`);

    return;
  }

  const interesting = [];

  for (const { file } of logFiles) {
    for (const line of readLines(file)) {
      if (mentionsThisPlugin(line)) {
        interesting.push({ file: path.relative(logsDirectory, file), line: line.trim() });
      }
    }
  }

  if (interesting.length === 0) {
    finding('warn', `no log line mentions this plugin in the ${logFiles.length} newest log file(s). If the plugin is also absent from the list, Flow did not even enumerate the folder.`);

    return;
  }

  for (const match of interesting.slice(-25)) {
    const isBlocker = /didn't exist|Invalid json|Invalid language|already loaded|Fail to Init/i.test(match.line);
    finding(isBlocker ? 'fail' : 'info', `${match.file}: ${match.line}`);
  }
}

function looksLikeLogFile (file) {
  return /\.(txt|log)$/i.test(file);
}

function mentionsThisPlugin (line) {
  const needles = [
    PLUGIN_ID,
    PLUGIN_NAME,
    PLUGIN_FOLDER_NAME,
    'Execute file path',
    'Emoji Finder'
  ].filter(needle => needle !== '');

  return needles.some(needle => line.includes(needle));
}

function inspectPluginSettings (dataDirectory) {
  const settingsDirectory = path.join(dataDirectory, 'Settings', 'Plugins');

  if (!fs.existsSync(settingsDirectory)) {
    return;
  }

  const folders = fs.readdirSync(settingsDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  if (folders.some(name => name.includes('Emoji'))) {
    finding('info', `plugin settings folder present: ${folders.find(name => name.includes('Emoji'))}`);
  }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function findFlowDataDirectory () {
  const candidates = [
    process.env.APPDATA === undefined ? null : path.join(process.env.APPDATA, 'FlowLauncher'),
    path.join(PLUGIN_ROOT, 'UserData')
  ].filter(candidate => candidate !== null && fs.existsSync(candidate));

  return candidates[0] ?? null;
}

function looksLikeThisPlugin (folderName) {
  return folderName === PLUGIN_FOLDER_NAME || folderName.toLowerCase().includes('emoji');
}

function listFiles (predicate, directory, results = []) {
  if (!fs.existsSync(directory)) {
    return results;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      listFiles(predicate, fullPath, results);
    } else if (predicate(entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}

function listJsonFiles (directory) {
  return listFiles(name => name.toLowerCase().endsWith('.json'), directory);
}

function readLines (file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function statOrNull (file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function finding (kind, message) {
  findings.push({ kind, message });

  if (kind === 'fail') {
    blockers++;
  }
}

function printFindings () {
  // Blockers first: they are what the reader came for, and the old order buried a single
  // FAIL under twenty lines of INFO from Flow's log.
  const order = { fail: 0, warn: 1, pass: 2, info: 3, skip: 4 };
  const sorted = [...findings].sort((first, second) => order[first.kind] - order[second.kind]);

  // Flow's log lines are numerous and chronological; they go last, after a heading, so
  // they cannot drown the verdict.
  const isLogLine = message => /\.log: /.test(message);
  const ownFindings = sorted.filter(finding => !isLogLine(finding.message));
  const logFindings = sorted.filter(finding => isLogLine(finding.message));

  for (const { kind, message } of ownFindings) {
    console.log(style.finding(kind, message));
  }

  if (logFindings.length > 0) {
    console.log(`\n${style.bold('Flow Launcher log')} ${style.dim('(newest first, this plugin only)')}`);

    for (const { kind, message } of logFindings.slice(0, 12)) {
      console.log(`  ${style.finding(kind, message)}`);
    }

    if (logFindings.length > 12) {
      console.log(style.dim(`  ... and ${logFindings.length - 12} more matching lines`));
    }
  }

  const verdict = blockers === 0
    ? style.green('verdict: nothing in the installation is obviously broken.')
    : style.red(`verdict: ${blockers} blocker(s).`);

  console.log(`\n${verdict}`);

  process.exitCode = blockers === 0 ? 0 : 1;
}

function writeReport () {
  const reportFile = path.join(
    PLUGIN_ROOT,
    'dogfood',
    process.platform === 'win32' ? 'doctor.json' : 'doctor-linux.json'
  );

  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify({
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      pluginRoot: PLUGIN_ROOT,
      dataDirectory,
      findings
    }, null, 2));

    console.log(`\nreport written to ${path.relative(PLUGIN_ROOT, reportFile)}`);
  } catch (error) {
    console.log(`could not write the report: ${error.message}`);
  }
}
