// src/utils/pluginData.ts
//
// Where this plugin keeps the two small pieces of state Flow Launcher does not hold for it:
// which emoji the user actually picks (so an empty query can be useful) and the user's own
// aliases.
//
// Location
// --------
// Flow stores per-plugin settings in `Settings\Plugins\<plugin name>\`, as a sibling of the
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
//   user-frecency.json  { "<emoji>": { "count": 3, "lastUsedAt": 1792757171938 } }
//   user-aliases.json   { "_HowToUse": "...", "swole": "💪" }
//
// Both are read defensively: a missing, empty or malformed file means "nothing learned yet",
// never a failed query. Writes go through a temporary file and a rename, because Flow starts a
// new process for every keystroke and for every pick, and two of them can overlap.

import fs from 'node:fs';
import path from 'node:path';

/** Our plugin ID, as in plugin.json. Tests pin it against the manifest. */
export const PLUGIN_ID = 'd50362aa29f04cd59032bb44a5d5f7e5';

/**
 * The two files this plugin keeps, named so their owner is obvious in a folder listing.
 *
 * Both live in Flow's settings folder for this plugin, next to the `Settings.json` it writes
 * itself. They are the user's data, not the plugin's: the aliases survive a reinstall, and the
 * frecency quietly makes the empty query theirs.
 */
export const USAGE_FILE_NAME = 'user-frecency.json';
export const ALIASES_FILE_NAME = 'user-aliases.json';

/**
 * How many emoji the history may contain.
 *
 * A few hundred is far beyond anything a person scrolls, and it keeps the file small enough
 * that reading it on every keystroke stays free.
 */
export const MAXIMUM_USAGE_ENTRIES = 300;

/**
 * The contents the aliases file is created with, when the user asks to open it before saving one.
 *
 * JSON has no comments, so the guidance is written as entries whose keys start with `_`: skipped
 * by every reader here, preserved by every writer, and invisible in the alias list. Three lines,
 * three jobs - what the file is for, the one warning worth having, and a worked example, because
 * an example answers "what does an alias look like" faster than any sentence.
 */
const ALIASES_FILE_TEMPLATE = {
  _HowToUse: 'You may manually edit this file to add aliases. Entries starting with _ such as these, are ignored. They\'re only because JSON doesn\'t support comments.',
  _Note: 'This file lives in the settings folder, so it survives plugin updates. Don\'t edit the emoji database directly as your changes would get lost on update!',
  _examplealias: '\u{1F4AA}'
};

/** Keys starting with `_` are documentation, not aliases. */
function isDocumentationKey (key: string): boolean {
  return key.startsWith('_');
}

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

/** What the plugin answers to when Flow has not been told otherwise; also plugin.json's value. */
export const DEFAULT_ACTION_KEYWORD = 'e';

/** Flow's own settings file, next to the per-plugin settings folder. */
export const FLOW_SETTINGS_FILE_NAME = 'Settings.json';

/** The settings folder's name if plugin.json cannot be read; also plugin.json's value. */
export const DEFAULT_PLUGIN_NAME = 'Emoji Finder';

/**
 * The keyword this plugin is currently invoked with, as Flow Launcher has it.
 *
 * Everything the plugin *says* uses this - every subtitle that shows a command, and the command
 * the context menu copies - because `e` is only the default: it can be changed in Flow's settings
 * like any other plugin's keyword, and a sentence that insists on `e` would then be handing out
 * a command that does not work.
 *
 * Flow keeps the keyword the user chose in its own `Settings.json`, under
 * `PluginSettings.Plugins.<plugin ID>.ActionKeywords` (Flow's `PluginsSettings.UpdatePluginSettings`
 * reads it back over the manifest's default). That file is the only place the choice is recorded,
 * since the query itself arrives without its keyword.
 *
 * Plugin.json is the fallback for a plugin that is not installed in a Flow layout - a test run, or
 * someone starting `dist/main.js` by hand - where the manifest's value is all there is.
 *
 * @param settingsDirectory Flow's settings folder for this plugin, or null when unknown.
 * @param pluginDirectory Where to find plugin.json.
 */
export function readActionKeyword (
  settingsDirectory: string | null = resolvePluginSettingsDirectory(),
  pluginDirectory: string = PLUGIN_DIRECTORY
): string {
  return readKeywordFromFlowSettings(settingsDirectory) ||
    readManifestString('ActionKeyword', pluginDirectory) ||
    DEFAULT_ACTION_KEYWORD;
}

/**
 * The first keyword Flow has stored for this plugin, or an empty string.
 *
 * `Settings\Plugins\<name>` is two levels below the folder holding `Settings.json`, so the path
 * is derived from where the plugin already knows it lives - no guessing at %APPDATA%, and the same
 * rule for installed and portable Flow Launcher.
 */
function readKeywordFromFlowSettings (settingsDirectory: string | null): string {
  if (settingsDirectory === null) {
    return '';
  }

  const flowSettingsFile = path.resolve(settingsDirectory, '..', '..', FLOW_SETTINGS_FILE_NAME);
  const settings = readJsonFile<Record<string, unknown>>(flowSettingsFile);
  const containers = [settings?.PluginSettings, settings];

  for (const container of containers) {
    const pluginSettings = (container as { Plugins?: Record<string, unknown> } | undefined)?.Plugins;

    if (pluginSettings === null || typeof pluginSettings !== 'object') {
      continue;
    }

    const entry = (pluginSettings as Record<string, { ActionKeywords?: unknown }>)[PLUGIN_ID];
    const keywords = entry?.ActionKeywords;

    if (Array.isArray(keywords)) {
      const first = keywords.find((keyword): keyword is string => typeof keyword === 'string' && keyword.trim() !== '');

      if (first !== undefined) {
        return first.trim();
      }
    }
  }

  return '';
}

/**
 * The plugin's name, as declared in its own plugin.json.
 *
 * Flow names a non-.NET plugin's settings folder after this, not after the ID
 * (`PluginManager.UpdatePluginDirectory`: `Path.Combine(PluginSettingsDirectory, metadata.Name)`
 * for everything that is not .NET). Before that was noticed, this plugin kept its files in a
 * folder named after its ID - a bare GUID next to a tidy "Emoji Finder" folder Flow had made, and
 * a `Settings.json` written into a folder Flow never reads.
 *
 * @param pluginDirectory Where to find plugin.json. Defaults to this plugin's folder.
 */
export function readPluginName (pluginDirectory: string = PLUGIN_DIRECTORY): string {
  return readManifestString('Name', pluginDirectory) || DEFAULT_PLUGIN_NAME;
}

/** One string field out of plugin.json, or an empty string when it is missing or unreadable. */
function readManifestString (field: string, pluginDirectory: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDirectory, 'plugin.json'), 'utf8')) as Record<string, unknown>;
    const value = manifest[field];

    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Flow's settings folder for this plugin, or null when this plugin is not inside a Flow
 * Launcher layout at all (a test run, or somebody running dist/main.js by hand).
 *
 * The folder is named after the plugin (`Emoji Finder`), because that is what Flow uses for
 * non-.NET plugins - see `readPluginName`.
 *
 * @param startDirectory Where to start looking. Defaults to this plugin's folder.
 * @param pluginName The folder name Flow uses. Defaults to this plugin's name.
 * @param maximumDepth How far to walk up before giving up.
 */
export function resolvePluginSettingsDirectory (
  startDirectory: string = PLUGIN_DIRECTORY,
  pluginName: string = readPluginName(),
  maximumDepth = 6
): string | null {
  let current = path.resolve(startDirectory);

  for (let depth = 0; depth <= maximumDepth; depth++) {
    if (path.basename(current).toLowerCase() === 'plugins') {
      return path.resolve(current, '..', 'Settings', 'Plugins', pluginName);
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
  const stored = readRawAliases(settingsDirectory);
  const aliases: AliasRecord = {};

  if (stored === null) {
    return aliases;
  }

  for (const [alias, emoji] of Object.entries(stored)) {
    const trimmed = alias.trim().toLowerCase();

    if (!isDocumentationKey(trimmed) && trimmed !== '' && typeof emoji === 'string' && emoji !== '') {
      aliases[trimmed] = emoji;
    }
  }

  return aliases;
}

/**
 * Everything in the file, documentation keys included, or null when it cannot be read.
 *
 * @param settingsDirectory Flow's settings folder for this plugin.
 */
function readRawAliases (settingsDirectory: string): Record<string, unknown> | null {
  const stored = readJsonFile<Record<string, unknown>>(path.join(settingsDirectory, ALIASES_FILE_NAME));

  return stored === null || typeof stored !== 'object' ? null : stored;
}

/**
 * The aliases file, created with its guidance entry if it is not there yet.
 *
 * Called from the action that opens the file. A user who wants to edit by hand has to end up in
 * a file that exists and says what to write; on a fresh install it does not exist, because
 * nothing has been saved yet.
 *
 * @returns The path to the file.
 */
export function ensureAliasesFile (settingsDirectory: string): string {
  const file = path.join(settingsDirectory, ALIASES_FILE_NAME);

  if (!fs.existsSync(file)) {
    // The folder belongs to Flow and usually exists already (it holds Settings.json), but a
    // fresh install that has never opened the settings page may not have it yet.
    fs.mkdirSync(settingsDirectory, { recursive: true });
    writeFileAtomically(file, JSON.stringify(ALIASES_FILE_TEMPLATE, null, 2));
  }

  return file;
}

/** Adds one alias and returns the saved map. An existing alias with the same name is replaced. */
export function saveAlias (settingsDirectory: string, alias: string, emoji: string): AliasRecord {
  const aliases = readAliases(settingsDirectory);
  const trimmed = alias.trim().toLowerCase();

  aliases[trimmed] = emoji;

  // Documentation keys survive a save: the file is written with what it says about itself, so
  // the first alias does not silently delete the only explanation of the format.
  const documentation = Object.fromEntries(
    Object.entries(readRawAliases(settingsDirectory) ?? {}).filter(([key]) => isDocumentationKey(key))
  );

  writeFileAtomically(
    path.join(settingsDirectory, ALIASES_FILE_NAME),
    JSON.stringify({ ...documentation, ...aliases })
  );

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
