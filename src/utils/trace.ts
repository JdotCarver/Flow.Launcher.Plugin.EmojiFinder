// src/utils/trace.ts
//
// Opt-in runtime tracing, so a failure on a Windows machine can be read from a file
// instead of guessed at. This project is developed in a Linux sandbox: PowerShell,
// clipboard access and Ctrl+V injection cannot be exercised there at all, so the only
// way to see what the plugin actually does on the user's machine is to write it down.
//
// Enabled by dropping an empty file named `trace.on` next to plugin.json (the plugin
// root). `npm run package -- --trace` does that for you. When the marker is absent,
// every function here returns immediately: normal installs write nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** dist/utils/trace.js -> dist/utils -> dist -> plugin root. */
const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Where trace lines are written. Committed by the maintainer between turns. */
export const TRACE_DIRECTORY = path.join(PLUGIN_ROOT, 'dogfood');
export const TRACE_FILE = path.join(TRACE_DIRECTORY, 'runtime.log');

/** Larger files are truncated rather than grown without bound. */
const MAXIMUM_TRACE_BYTES = 256 * 1024;

/**
 * A trace file that only ever grows is a bug waiting to happen on someone else's disk.
 */
function truncateIfOversized (filePath: string): void {
  try {
    if (fs.statSync(filePath).size > MAXIMUM_TRACE_BYTES) {
      fs.writeFileSync(filePath, '');
    }
  } catch {
    // Missing file: nothing to truncate.
  }
}

/**
 * Appends one JSON line. Never throws: tracing must not be able to break the plugin.
 *
 * @param filePath File to append to (its directory is created if needed).
 * @param event Short, stable name such as "paste:spawn" or "trace:enabled".
 * @param details Extra fields; must be JSON-serialisable.
 */
export function appendTraceLine (
  filePath: string,
  event: string,
  details: Record<string, unknown> = {}
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    truncateIfOversized(filePath);

    const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });

    fs.appendFileSync(filePath, line + '\n');
  } catch {
    // A read-only install folder is not a reason to fail a copy or a paste.
  }
}

/**
 * Whether tracing was switched on for this installation.
 *
 * @param pluginRoot Defaults to the running plugin; overridable for tests.
 */
export function isTracingEnabled (pluginRoot: string = PLUGIN_ROOT): boolean {
  try {
    return fs.existsSync(path.join(pluginRoot, 'trace.on'));
  } catch {
    return false;
  }
}

/**
 * Records an event when tracing is on, and does nothing otherwise.
 */
export function trace (event: string, details: Record<string, unknown> = {}): void {
  if (!isTracingEnabled()) {
    return;
  }

  appendTraceLine(TRACE_FILE, event, details);
}
