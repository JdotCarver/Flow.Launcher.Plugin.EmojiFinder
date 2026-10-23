// src/main.ts
//
// Entry point. Flow Launcher runs `node dist/main.js '<json>'` once per keystroke
// (method "query") and once when the user picks a result (method "copy" or "paste").

import process from 'node:process';
import type { Arguments } from './types.js';
import { copy } from './actions/copy.js';
import { paste } from './actions/paste.js';
import { query } from './actions/query.js';
import { trace } from './utils/trace.js';

const args: Arguments = JSON.parse(process.argv[2] ?? '{}');
const { method, parameters, settings } = args;

if (method === 'query') {
  const input = parameters[0] as string;

  query(input, settings);
}

// Actions are traced, queries are not: there is one of these per Enter and one of those
// per keystroke, and the paste helper is what needs the paper trail.
if (method !== 'query') {
  trace('method', { method, parameters });
}

if (method === 'copy') {
  const emoji = parameters[0] as string;
  const enableNotification = parameters[1] as boolean ?? true;

  // Awaited so the process lives long enough for the deferred clipboard import.
  await copy(emoji, enableNotification);
}

if (method === 'paste') {
  const emoji = parameters[0] as string;

  paste(emoji);
}
