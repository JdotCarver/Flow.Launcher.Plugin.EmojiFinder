// src/main.ts
//
// Entry point. Flow Launcher runs `node dist/main.js '<json>'` once per keystroke
// (method "query") and once when the user picks a result (method "copy" or "paste").

import process from 'node:process';
import type { Arguments } from './types.js';
import { buildContextMenu } from './actions/aliases.js';
import { copy } from './actions/copy.js';
import { paste } from './actions/paste.js';
import { query } from './actions/query.js';
import { emojiDatabasePath } from './utils/find.js';
import { sendJsonRpcRequest } from './utils/flowLauncher.js';
import { removeAlias, resolvePluginSettingsDirectory, saveAlias } from './utils/pluginData.js';
import { trace } from './utils/trace.js';

const args: Arguments = JSON.parse(process.argv[2] ?? '{}');
const { method, parameters, settings } = args;

if (method === 'query') {
  const input = parameters[0] as string;

  query(input, settings);
}

// Flow Launcher implements its right-arrow menu for JS plugins by asking the plugin for it:
// the selected result's ContextData arrives as the only parameter, and the list of results we
// print becomes the menu.
if (method === 'context_menu') {
  const emoji = parameters[0] as string;
  const settingsDirectory = resolvePluginSettingsDirectory();

  sendJsonRpcRequest({
    result: buildContextMenu(emoji, { settingsDirectory, emojiDatabase: emojiDatabasePath() })
  });
}

// Actions are traced, queries are not: there is one of these per Enter and one of those
// per keystroke, and the paste agent is what needs the paper trail.
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

// Enter on "Save ... for 💪": write the alias, then say so.
if (method === 'addalias') {
  const alias = parameters[0] as string;
  const emoji = parameters[1] as string;
  const settingsDirectory = resolvePluginSettingsDirectory();

  if (settingsDirectory !== null) {
    saveAlias(settingsDirectory, alias, emoji);
  }

  trace('alias:added', { alias, emoji, saved: settingsDirectory !== null });
  sendJsonRpcRequest({
    method: 'Flow.Launcher.ShowMsg',
    parameters: [`${emoji} now answers to "${alias}"`, 'Flow Launcher Emoji Finder', 'img\\app.png']
  });
}

// Enter on an entry of the alias list: remove it, and say so through Flow's own notification.
if (method === 'removealias') {
  const alias = parameters[0] as string;
  const settingsDirectory = resolvePluginSettingsDirectory();
  const aliases = settingsDirectory === null ? {} : removeAlias(settingsDirectory, alias);

  trace('alias:removed', { alias, remaining: Object.keys(aliases).length });
  sendJsonRpcRequest({
    method: 'Flow.Launcher.ShowMsg',
    parameters: [`Removed the alias "${alias}"`, 'Flow Launcher Emoji Finder', 'img\\app.png']
  });
}
