// src/utils/pluginData.ts
//
// Where this plugin keeps the two small pieces of state Flow Launcher does not hold for it:
// which emoji the user actually picks (so an empty query can be useful) and the user's own
// aliases.
//
// Location
// --------
// Flow stores per-plugin settings in `Settings\Plugins\<plugin ID>\`, as a sibling of the
// `Plugins` folder it loads us from. That is true for an installed Flow
// (`%APPDATA%\FlowLauncher\...`) and for a portable one (`<Flow folder>\UserData\...`), so the
// same rule covers both without asking the user which they have, and without looking at where
// Flow Launcher lives - the same rule the paste agent follows.
//
// Orphan risk is the reason for the walk-up instead of a hard-coded `%APPDATA%`: a portable
// user's settings folder exists next to their Flow, and writing into %APPDATA% would create a
// second, invisible copy of the history.
//
// Files
// -----
//   usage.json     { "<emoji>": { "count": 3, "lastUsedAt": 1792757171938 } }
//   aliases.json   { "swole": "💪" }
//
// Both are read defensively: a missing, empty or malformed file means "nothing learned yet",
// never a failed query. Writes go through a temporary file and a rename, because Flow starts a
// new process for every keystroke and for every pick, and two of them can overlap.

import fs from 'node:fs';
import path from 'node:path';

/** Our plugin ID, as in plugin.json. Used to find the settings folder Flow owns for us. */
export const PLUGIN_ID = 'd50362aa29f04cd59032bb44a5d5f7e5';

export const USAGE_FILE_NAME = 'usage.json';
export const ALIASES_FILE_NAME = 'aliases.json';

/**
 * How many emoji the history may contain.
 *
 * A few hundred is far beyond anything a person scrolls, and it keeps the file small enough
 * that reading it on every keystroke stays free.
 */
export const MAXIMUM_USAGE_ENTRIES = 300;

export type UsageRecord = Record<string, { count: number, lastUsedAt: number }>;

export type AliasRecord = Record<string, string>;

/**
 * The plugin's own folder.
 *
 * This file is compiled to `dist/utils/pluginData.js`, so the plugin folder is two levels up -
 * and it is the folder that contains `plugin.json` and `dist/`, for an installed and a portable
 * Flow Launcher alike.
 */
export const PLUGIN_DIRECTORY = path.resolve(import.meta.dirname, '..', '..');

/**
 * Flow's settings folder for this plugin, or null when this plugin is not inside a Flow
 * Launcher layout at all (a test run, or somebody running dist/main.js by hand).
 *
 * @param startDirectory Where to start looking. Defaults to this plugin's folder.
 * @param pluginId The folder name Flow uses. Defaults to our own ID.
 * @param maximumDepth How far to walk up before giving up.
 */
export function resolvePluginSettingsDirectory (
  startDirectory: string = PLUGIN_DIRECTORY,
  pluginId: string = PLUGIN_ID,
  maximumDepth = 6
): string | null {
  let current = path.resolve(startDirectory);

  for (let depth = 0; depth <= maximumDepth; depth++) {
    if (path.basename(current).toLowerCase() === 'plugins') {
      return path.resolve(current, '..', 'Settings', 'Plugins', pluginId);
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }

  return null;
}

/** Reads JSON, or null when the file is missing or is not JSON. */
function readJsonFile<T> (filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Writes text through a temporary file and a rename, so no reader ever sees half a file. */
function writeFileAtomically (filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const temporaryFile = `${filePath}.tmp`;

  fs.writeFileSync(temporaryFile, contents);
  fs.renameSync(temporaryFile, filePath);
}

/**
 * The usage history, or an empty one.
 *
 * Entries are validated one by one: a hand-edited or half-written file degrades to "fewer
 * entries", not to a query that throws.
 */
export function readUsage (settingsDirectory: string): UsageRecord {
  const stored = readJsonFile<Record<string, unknown>>(path.join(settingsDirectory, USAGE_FILE_NAME));
  const usage: UsageRecord = {};

  if (stored === null || typeof stored !== 'object') {
    return usage;
  }

  for (const [emoji, value] of Object.entries(stored)) {
    const entry = value as { count?: unknown, lastUsedAt?: unknown };
    const count = Number(entry?.count);
    const lastUsedAt = Number(entry?.lastUsedAt);

    if (Number.isFinite(count) && count > 0) {
      usage[emoji] = { count, lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : 0 };
    }
  }

  return usage;
}

/**
 * Records one pick and returns the new history.
 *
 * The cap is enforced by dropping the least useful entries: fewest picks first, and the oldest
 * among equals. Nobody has 300 favourites, so pruning is invisible; it exists so the file
 * cannot grow without bound.
 */
export function recordUsage (settingsDirectory: string, emoji: string, now: number = Date.now()): UsageRecord {
  const usage = readUsage(settingsDirectory);
  const previous = usage[emoji];

  usage[emoji] = { count: (previous?.count ?? 0) + 1, lastUsedAt: now };

  // Room is made among the *other* entries, never at the expense of the pick that just
  // happened: a first pick has the lowest count there is, so a plain sort would drop the very
  // emoji the user just chose.
  const others = Object.entries(usage).filter(([storedEmoji]) => storedEmoji !== emoji);
  const excess = others.length + 1 - MAXIMUM_USAGE_ENTRIES;

  if (excess > 0) {
    others
      .sort((first, second) => first[1].count - second[1].count || first[1].lastUsedAt - second[1].lastUsedAt)
      .slice(0, excess)
      .forEach(([droppedEmoji]) => {
        delete usage[droppedEmoji];
      });
  }

  writeFileAtomically(path.join(settingsDirectory, USAGE_FILE_NAME), JSON.stringify(usage));

  return usage;
}

/**
 * The user's aliases, lowercased, or an empty map.
 *
 * Aliases are matched against what the user types, so they are stored in the same form the
 * query is compared in. A value that is not a non-empty string is ignored rather than trusted.
 */
export function readAliases (settingsDirectory: string): AliasRecord {
  const stored = readJsonFile<Record<string, unknown>>(path.join(settingsDirectory, ALIASES_FILE_NAME));
  const aliases: AliasRecord = {};

  if (stored === null || typeof stored !== 'object') {
    return aliases;
  }

  for (const [alias, emoji] of Object.entries(stored)) {
    const trimmed = alias.trim().toLowerCase();

    if (trimmed !== '' && typeof emoji === 'string' && emoji !== '') {
      aliases[trimmed] = emoji;
    }
  }

  return aliases;
}

/** Adds one alias and returns the saved map. An existing alias with the same name is replaced. */
export function saveAlias (settingsDirectory: string, alias: string, emoji: string): AliasRecord {
  const aliases = readAliases(settingsDirectory);
  const trimmed = alias.trim().toLowerCase();

  aliases[trimmed] = emoji;
  writeFileAtomically(path.join(settingsDirectory, ALIASES_FILE_NAME), JSON.stringify(aliases));

  return aliases;
}

/** Removes one alias and returns the saved map. Removing an alias that is not there is fine. */
export function removeAlias (settingsDirectory: string, alias: string): AliasRecord {
  const aliases = readAliases(settingsDirectory);
  const trimmed = alias.trim().toLowerCase();

  if (trimmed in aliases) {
    delete aliases[trimmed];
    writeFileAtomically(path.join(settingsDirectory, ALIASES_FILE_NAME), JSON.stringify(aliases));
  }

  return aliases;
}
