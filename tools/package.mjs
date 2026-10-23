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
//
// Exit code 0 means the folder is ready.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN_FOLDER_NAME = 'Flow.Launcher.Plugin.EmojiFinder';
const OUTPUT_DIR = path.join(PLUGIN_ROOT, 'artifacts', PLUGIN_FOLDER_NAME);

/** Everything a running plugin needs. Anything else in the repo is development-only. */
const FILES = ['plugin.json', 'package.json', 'SettingsTemplate.yaml'];
const DIRECTORIES = ['dist', 'icons', 'img'];

function main () {
  assertBuildExists();

  const shouldInstall = process.argv.includes('--install');

  cleanOutputDirectory();
  copyFiles();
  copyProductionDependencies();

  report();

  if (shouldInstall) {
    installIntoFlowLauncher();
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
 */
function copyProductionDependencies () {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  let listing;
  try {
    listing = execFileSync(npmCommand, ['ls', '--omit=dev', '--all', '--parseable'], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8'
    });
  } catch (error) {
    // npm ls exits non-zero on unmet peers while still printing a usable tree.
    listing = String(error.stdout ?? '');
  }

  const packagePaths = listing
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && line !== PLUGIN_ROOT)
    .filter(line => line.includes(`${path.sep}node_modules${path.sep}`));

  for (const packagePath of packagePaths) {
    const relativePath = packagePath.slice(packagePath.lastIndexOf('node_modules') + 'node_modules'.length);
    const destination = path.join(OUTPUT_DIR, 'node_modules', relativePath);

    fs.cpSync(packagePath, destination, { recursive: true, filter: isNotDevelopmentNoise });
  }
}

/** Skips test folders and other files that never run in the plugin. */
function isNotDevelopmentNoise (source) {
  const name = path.basename(source);

  return name !== 'test' && name !== 'tests' && name !== '.bin';
}

function report () {
  const totalBytes = directorySize(OUTPUT_DIR);

  console.log(`packaged ${PLUGIN_FOLDER_NAME}`);
  console.log(`  ${OUTPUT_DIR}`);
  console.log(`  ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
}

function directorySize (directory) {
  return fs.readdirSync(directory, { recursive: true })
    .map(entry => path.join(directory, String(entry)))
    .filter(entry => fs.statSync(entry).isFile())
    .reduce((total, entry) => total + fs.statSync(entry).size, 0);
}

function flowLauncherPluginsDirectory () {
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
    console.error('Portable Flow Launcher installs keep plugins in <Flow folder>\\UserData\\Plugins instead.');
    console.error('Copy the packaged folder there by hand (and delete the old copy first).');
    process.exit(1);
  }

  const destination = path.join(pluginsDirectory, PLUGIN_FOLDER_NAME);

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(OUTPUT_DIR, destination, { recursive: true });

  console.log(`\ninstalled to ${destination}`);
  console.log('Restart Flow Launcher (right-click the tray icon, or run `Flow Launcher` and use the Refresh command).');
}

main();
