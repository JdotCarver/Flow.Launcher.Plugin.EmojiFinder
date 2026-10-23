// tools/package.mjs
//
// Builds a drop-in plugin folder that Flow Launcher can load.
//
// Flow Launcher does not run this repository: it runs `dist/main.js` from a plugin
// folder, and it silently ignores any folder whose `plugin.json` points at a file that
// does not exist. A fresh checkout has no `dist/` (it is gitignored) and no production
// `node_modules`, so copying source files into the Plugins folder makes the plugin
// vanish from the launcher. This script produces exactly what Flow expects:
//
//   artifacts/Flow.Launcher.Plugin.EmojiFinder/
//     dist/                  compiled JavaScript (tsc output)
//     icons/                 emoji PNGs
//     img/                   plugin icon
//     node_modules/          production dependencies only (emojilib, clipboardy, ...)
//     package.json           needed: it declares "type": "module" for the ESM output
//     plugin.json            the manifest Flow reads
//     SettingsTemplate.yaml  the settings page
//
// Usage
//   npm run package              # build into artifacts/
//   npm run package -- --install # ...and copy it into the Flow Launcher plugins folder
//   npm run package -- --install --install-to "D:\Flow\UserData\Plugins"
//                                # ...for a PORTABLE Flow Launcher, which keeps plugins
//                                #    next to itself instead of in %APPDATA%
//   npm run package -- --install --trace
//                                # ...with runtime tracing switched on (writes
//                                #    dogfood/runtime.log next to the plugin, see
//                                #    docs/DOGFOODING.md)
//   npm run package -- --install --no-agent
//                                # ...without starting the paste agent (copy-only users)
//
// Exit code 0 means the folder is ready.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { dependencyRelativePaths } from './package-paths.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN_FOLDER_NAME = 'Flow.Launcher.Plugin.EmojiFinder';
const OUTPUT_DIR = path.join(PLUGIN_ROOT, 'artifacts', PLUGIN_FOLDER_NAME);

/** Everything a running plugin needs. Anything else in the repo is development-only. */
const FILES = ['plugin.json', 'package.json', 'SettingsTemplate.yaml'];
const DIRECTORIES = ['dist', 'icons', 'img'];

function main () {
  assertBuildExists();

  const shouldInstall = process.argv.includes('--install');
  const shouldTrace = process.argv.includes('--trace');

  cleanOutputDirectory();
  copyFiles();
  copyProductionDependencies();

  if (shouldTrace) {
    enableTracing();
  }

  assertRuntimeIsComplete(OUTPUT_DIR);
  report(shouldTrace);

  if (shouldInstall) {
    installIntoFlowLauncher();

    if (!process.argv.includes('--no-agent')) {
      installPasteAgent();
    }
  } else {
    console.log('\nNext: copy that folder into your Flow Launcher plugins folder, or rerun with --install.');
    console.log(`  ${flowLauncherPluginsDirectory() ?? '%APPDATA%\\FlowLauncher\\Plugins'}`);
  }
}

function assertBuildExists () {
  const entryPoint = path.join(PLUGIN_ROOT, 'dist', 'main.js');

  if (!fs.existsSync(entryPoint)) {
    console.error('No build found. Run: npm run build');
    process.exit(1);
  }

  // A stale build is worse than no build: it "works" but silently misses your changes.
  const sourceFiles = fs.readdirSync(path.join(PLUGIN_ROOT, 'src'), { recursive: true })
    .map(file => path.join(PLUGIN_ROOT, 'src', String(file)))
    .filter(file => fs.statSync(file).isFile());

  const newestSource = Math.max(...sourceFiles.map(file => fs.statSync(file).mtimeMs));

  if (newestSource > fs.statSync(entryPoint).mtimeMs) {
    console.error('dist/ is older than src/. Run: npm run build');
    process.exit(1);
  }
}

function cleanOutputDirectory () {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function copyFiles () {
  for (const file of FILES) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, file), path.join(OUTPUT_DIR, file));
  }

  for (const directory of DIRECTORIES) {
    fs.cpSync(path.join(PLUGIN_ROOT, directory), path.join(OUTPUT_DIR, directory), { recursive: true });
  }
}

/**
 * Copies only the packages the plugin needs at runtime, keeping the flat
 * node_modules layout Node's resolver expects.
 *
 * `npm prune --omit=dev` would be simpler but it mutates the development install;
 * `npm ls` tells us the same tree without touching anything.
 *
 * Two Windows traps live here, both discovered the hard way on a real install:
 *
 *   1. `execFileSync('npm.cmd', ...)` throws EINVAL on Node 18.20+/20.12+ - the fix for a
 *      command-injection bug refuses to run `.cmd` files without a shell. The failure used
 *      to be swallowed by a catch, which meant *zero* dependencies were copied and the
 *      plugin still "packaged successfully". It is passed through a shell instead, and a
 *      failure is fatal.
 *   2. `npm ls --parseable` mixes `\` and `/` in its paths, so the parsing lives in
 *      tools/package-paths.mjs where it can be tested for both.
 */
function copyProductionDependencies () {
  const listing = listProductionDependencies();
  const packagePaths = dependencyRelativePaths(listing);

  if (packagePaths.length === 0) {
    fail('Could not find any production dependencies to copy.\n' +
      'npm printed no packages, so the installed plugin would be missing node_modules.\n' +
      `Output was:\n${listing.trim().slice(0, 2000) || '(empty)'}`);
  }

  for (const relativePath of packagePaths) {
    const source = path.join(PLUGIN_ROOT, 'node_modules', ...relativePath.split('/'));
    const destination = path.join(OUTPUT_DIR, 'node_modules', ...relativePath.split('/'));

    fs.cpSync(source, destination, { recursive: true, filter: isNotDevelopmentNoise });
  }
}

/** Runs `npm ls` and returns its output, failing loudly rather than returning nothing. */
function listProductionDependencies () {
  const isWindows = process.platform === 'win32';

  try {
    return execFileSync(
      isWindows ? 'npm.cmd' : 'npm',
      ['ls', '--omit=dev', '--all', '--parseable'],
      {
        cwd: PLUGIN_ROOT,
        encoding: 'utf8',
        // Required on Windows since Node refuses to execute .cmd files without a shell.
        shell: isWindows
      }
    );
  } catch (error) {
    // `npm ls` exits non-zero for unmet peers while still printing a usable tree, so only
    // a run that produced no output at all is a real failure.
    const output = String(error.stdout ?? '');

    if (output.trim() === '') {
      return fail(`Could not list production dependencies:\n${error.message}`);
    }

    return output;
  }
}

/** Skips test folders and other files that never run in the plugin. */
function isNotDevelopmentNoise (source) {
  const name = path.basename(source);

  return name !== 'test' && name !== 'tests' && name !== '.bin';
}

/**
 * Drops the `trace.on` marker next to plugin.json. The plugin only writes trace lines
 * when it finds that file, so a normal install stays silent.
 */
function enableTracing () {
  fs.writeFileSync(path.join(OUTPUT_DIR, 'trace.on'), '');
}

/**
 * Refuses to call a package successful when the folder cannot run.
 *
 * A plugin without its dependencies still passes every earlier step: `dist/main.js`
 * exists, the manifest is there, the size looks plausible. It only fails inside Flow
 * Launcher, where the error is a log line the user has to go looking for. Checking the one
 * file emoji search cannot work without turns that into a packaging error.
 */
function assertRuntimeIsComplete (directory) {
  const requiredFiles = [
    path.join('dist', 'main.js'),
    path.join('node_modules', 'emojilib', 'dist', 'emoji-en-US.json')
  ];

  for (const requiredFile of requiredFiles) {
    if (!fs.existsSync(path.join(directory, requiredFile))) {
      fail(`${directory} is missing ${requiredFile}; Flow Launcher could not use it.`);
    }
  }
}

function fail (message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function report (tracing) {
  const totalBytes = directorySize(OUTPUT_DIR);

  console.log(`packaged ${PLUGIN_FOLDER_NAME}`);
  console.log(`  ${OUTPUT_DIR}`);
  console.log(`  ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  if (tracing) {
    console.log('  tracing ON: the plugin will append to dogfood/runtime.log in this folder');
  }
}

function directorySize (directory) {
  return fs.readdirSync(directory, { recursive: true })
    .map(entry => path.join(directory, String(entry)))
    .filter(entry => fs.statSync(entry).isFile())
    .reduce((total, entry) => total + fs.statSync(entry).size, 0);
}

/**
 * The plugins folder to install into.
 *
 * `--install-to` wins, which is what makes portable Flow Launcher work: a portable copy
 * keeps its plugins in `<Flow folder>\UserData\Plugins` and there is no reliable way to
 * guess that folder from %APPDATA%. Everything the plugin and the paste agent do afterwards
 * is independent of this choice - the agent lives in %LOCALAPPDATA% and its Startup entry is
 * per user.
 */
function flowLauncherPluginsDirectory () {
  const overrideIndex = process.argv.indexOf('--install-to');

  if (overrideIndex !== -1) {
    const overridden = process.argv[overrideIndex + 1];

    if (overridden === undefined || !fs.existsSync(overridden)) {
      console.error(`--install-to points at a folder that does not exist: ${overridden ?? '(nothing given)'}`);
      process.exit(1);
    }

    return path.resolve(overridden);
  }

  const roamingData = process.env.APPDATA;

  if (roamingData === undefined) {
    return null;
  }

  const pluginsDirectory = path.join(roamingData, 'FlowLauncher', 'Plugins');

  return fs.existsSync(pluginsDirectory) ? pluginsDirectory : null;
}

function installIntoFlowLauncher () {
  const pluginsDirectory = flowLauncherPluginsDirectory();

  if (pluginsDirectory === null) {
    console.error('\nCould not find %APPDATA%\\FlowLauncher\\Plugins.');
    console.error('Portable Flow Launcher installs keep plugins in <Flow folder>\\UserData\\Plugins instead,');
    console.error('and are installed with:');
    console.error('  npm run package -- --install --install-to "<Flow folder>\\UserData\\Plugins"');
    process.exit(1);
  }

  const destination = path.join(pluginsDirectory, PLUGIN_FOLDER_NAME);

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(OUTPUT_DIR, destination, { recursive: true });
  assertRuntimeIsComplete(destination);

  console.log(`\ninstalled to ${destination}`);
  console.log('Restart Flow Launcher (right-click the tray icon, or run `Flow Launcher` and use the Refresh command).');
}

/**
 * Starts the paste agent and makes it come back at login.
 *
 * Both live outside the plugin folder on purpose: the agent is a resident process, not a
 * child of Flow Launcher, and keeping its script and state in %LOCALAPPDATA% means a
 * portable installation (or a reinstall into a different folder) keeps working without
 * anything to re-register.
 *
 * Failures are reported but do not fail the install: paste falls back to copying, which is
 * still a working plugin.
 */
function installPasteAgent () {
  if (process.platform !== 'win32') {
    console.log('\npaste agent: skipped (Windows-only)');

    return;
  }

  for (const argument of ['--start', '--install-startup']) {
    try {
      const output = execFileSync(process.execPath, [path.join(PLUGIN_ROOT, 'tools', 'paste-agent.mjs'), argument], {
        cwd: PLUGIN_ROOT,
        encoding: 'utf8',
        timeout: 30000
      }).trim();

      console.log(output);
    } catch (error) {
      console.log(`paste agent: ${argument} failed (${error.message})`);
      console.log('paste will fall back to copying. Run: npm run agent -- --start');
    }
  }
}

main();
