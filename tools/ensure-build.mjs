// tools/ensure-build.mjs
//
// Makes sure `dist/` exists and is newer than `src/` before a tool imports from it.
//
// Why this exists: the tools under tools/ are plain JavaScript, but they share the agent's
// protocol with the plugin by importing the compiled TypeScript (`dist/utils/pasteAgent.js`).
// That is deliberate - one implementation, not two - but it means a fresh checkout has no
// dist/, and `npm run agent -- --stop` dies with a module-not-found stack trace that says
// nothing about the actual answer ("build first"). `dist/` is not committed, so this is the
// normal state of a checkout, not an edge case.
//
// So every script that needs dist/ runs this first. It is silent when there is nothing to do
// and prints one line when it had to run the compiler.
//
// Usage
//   node tools/ensure-build.mjs      (wired into the npm scripts; not meant to be called by hand)

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createStyle } from './report-style.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRECTORY = path.join(PLUGIN_ROOT, 'src');
const COMPILED_ENTRY = path.join(PLUGIN_ROOT, 'dist', 'utils', 'pasteAgent.js');

const style = createStyle();

/** The newest modification time in a folder tree, or 0 when the folder is empty. */
function newestModification (directory) {
  let newest = 0;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const modifiedAt = entry.isDirectory() ? newestModification(entryPath) : fs.statSync(entryPath).mtimeMs;

    newest = Math.max(newest, modifiedAt);
  }

  return newest;
}

function compiledIsCurrent () {
  try {
    return fs.statSync(COMPILED_ENTRY).mtimeMs >= newestModification(SOURCE_DIRECTORY);
  } catch {
    return false;
  }
}

if (!compiledIsCurrent()) {
  console.log(style.finding('info', 'compiling src/ before using dist/ (npm run build)'));

  // Run tsc through node rather than through a shell: `npx` is a .cmd on Windows, and a
  // shell here would be one more thing that behaves differently on each platform.
  const typescript = createRequire(import.meta.url).resolve('typescript/bin/tsc');

  execFileSync(process.execPath, [typescript], { cwd: PLUGIN_ROOT, stdio: 'inherit' });
}
