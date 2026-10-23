// tests/utils/pluginData.test.ts
//
// The two files this plugin owns: the usage history that makes an empty query useful, and the
// user's aliases. The rules worth pinning down are about the edges - a folder that is not a
// Flow Launcher layout, a corrupted file, a hand-edited entry - because the query path must
// never fail because of a data file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  MAXIMUM_USAGE_ENTRIES,
  PLUGIN_ID,
  USAGE_FILE_NAME,
  ALIASES_FILE_NAME,
  FLOW_SETTINGS_FILE_NAME,
  migrateEnterModeSetting,
  readAliases,
  readUsage,
  recordUsage,
  removeAlias,
  resolvePluginSettingsDirectory,
  saveAlias
} from '../../src/utils/pluginData.js';

const temporaryDirectories: string[] = [];

function createDirectory (): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-data-test-'));

  temporaryDirectories.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolvePluginSettingsDirectory', () => {
  test('finds the settings folder of an installed Flow Launcher', () => {
    const root = createDirectory();
    const pluginDirectory = path.join(root, 'FlowLauncher', 'Plugins', 'Flow.Launcher.Plugin.EmojiFinder');

    fs.mkdirSync(pluginDirectory, { recursive: true });

    expect(resolvePluginSettingsDirectory(pluginDirectory)).toBe(
      path.join(root, 'FlowLauncher', 'Settings', 'Plugins', PLUGIN_ID)
    );
  });

  test('finds the settings folder of a portable Flow Launcher the same way', () => {
    const root = createDirectory();
    const pluginDirectory = path.join(root, 'Flow', 'UserData', 'Plugins', 'Flow.Launcher.Plugin.EmojiFinder');

    fs.mkdirSync(pluginDirectory, { recursive: true });

    expect(resolvePluginSettingsDirectory(pluginDirectory)).toBe(
      path.join(root, 'Flow', 'UserData', 'Settings', 'Plugins', PLUGIN_ID)
    );
  });

  test('returns null rather than guessing when this is not a Flow Launcher layout', () => {
    const directory = createDirectory();

    expect(resolvePluginSettingsDirectory(path.join(directory, 'src', 'utils'))).toBeNull();
  });
});

describe('the plugin ID', () => {
  test('matches plugin.json, which is what Flow builds the folder name from', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'plugin.json'), 'utf8'));

    expect(manifest.ID).toBe(PLUGIN_ID);
  });
});

describe('readUsage', () => {
  test('a missing file is an empty history, not an error', () => {
    expect(readUsage(createDirectory())).toEqual({});
  });

  test('a corrupted file is an empty history, not an error', () => {
    const directory = createDirectory();

    fs.writeFileSync(path.join(directory, USAGE_FILE_NAME), '{ not json');

    expect(readUsage(directory)).toEqual({});
  });

  test('entries that are not usable counts are dropped, the rest are kept', () => {
    const directory = createDirectory();

    fs.writeFileSync(path.join(directory, USAGE_FILE_NAME), JSON.stringify({
      '🙈': { count: 2, lastUsedAt: 100 },
      '🧪': { count: 'many', lastUsedAt: 100 },
      '🚀': { count: 0, lastUsedAt: 100 },
      '❤️': { count: 1 }
    }));

    expect(readUsage(directory)).toEqual({
      '🙈': { count: 2, lastUsedAt: 100 },
      '❤️': { count: 1, lastUsedAt: 0 }
    });
  });
});

describe('recordUsage', () => {
  test('counts a pick and remembers when it happened', () => {
    const directory = createDirectory();

    recordUsage(directory, '🙈', 1000);
    const usage = recordUsage(directory, '🙈', 2000);

    expect(usage['🙈']).toEqual({ count: 2, lastUsedAt: 2000 });
    expect(readUsage(directory)).toEqual(usage);
  });

  test('drops the least used entries instead of growing without bound', () => {
    const directory = createDirectory();
    const stored: Record<string, { count: number, lastUsedAt: number }> = {};

    for (let index = 0; index <= MAXIMUM_USAGE_ENTRIES; index++) {
      stored[`emoji-${index}`] = { count: index + 1, lastUsedAt: index };
    }

    fs.writeFileSync(path.join(directory, USAGE_FILE_NAME), JSON.stringify(stored));

    const usage = recordUsage(directory, '🚀', 5000);

    expect(Object.keys(usage)).toHaveLength(MAXIMUM_USAGE_ENTRIES);
    // The pick that just happened survives even though it has the lowest count of all, and
    // room is made by dropping the least used entries.
    expect(usage['🚀']).toEqual({ count: 1, lastUsedAt: 5000 });
    expect(usage[`emoji-${MAXIMUM_USAGE_ENTRIES}`]).toBeDefined();
    expect(usage['emoji-0']).toBeUndefined();
    expect(usage['emoji-1']).toBeUndefined();
  });

  test('leaves no temporary file behind', () => {
    const directory = createDirectory();

    recordUsage(directory, '🙈', 1000);

    expect(fs.readdirSync(directory)).toEqual([USAGE_FILE_NAME]);
  });
});

describe('migrateEnterModeSetting', () => {
  function writeFlowSettings (directory: string, settings: Record<string, unknown>): void {
    fs.writeFileSync(path.join(directory, FLOW_SETTINGS_FILE_NAME), JSON.stringify(settings));
  }

  function readFlowSettings (directory: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(directory, FLOW_SETTINGS_FILE_NAME), 'utf8'));
  }

  test('translates an old dropdown value, which Flow would otherwise show as an empty box', () => {
    const directory = createDirectory();

    writeFlowSettings(directory, { defaultAction: 'paste', maxResults: '25' });

    expect(migrateEnterModeSetting(directory)).toBe('Paste Mode');
    expect(readFlowSettings(directory)).toEqual({ defaultAction: 'Paste Mode', maxResults: '25' });
  });

  test('leaves a value that is already current alone', () => {
    const directory = createDirectory();

    writeFlowSettings(directory, { defaultAction: 'Paste Mode' });

    expect(migrateEnterModeSetting(directory)).toBeNull();
  });

  test('does nothing when there is no settings file or no folder', () => {
    expect(migrateEnterModeSetting(createDirectory())).toBeNull();
    expect(migrateEnterModeSetting(null)).toBeNull();
  });

  test('keeps the other settings in the file', () => {
    const directory = createDirectory();

    writeFlowSettings(directory, { enableNotification: false, defaultAction: 'copy' });

    migrateEnterModeSetting(directory);
    expect(readFlowSettings(directory)).toEqual({ enableNotification: false, defaultAction: 'Copy Mode' });
  });
});

describe('aliases', () => {
  test('a missing file is no aliases', () => {
    expect(readAliases(createDirectory())).toEqual({});
  });

  test('names are compared the way the query is compared: trimmed and lowercased', () => {
    const directory = createDirectory();

    fs.writeFileSync(path.join(directory, ALIASES_FILE_NAME), JSON.stringify({ '  Swole ': '💪' }));

    expect(readAliases(directory)).toEqual({ swole: '💪' });
  });

  test('values that are not emoji are ignored rather than trusted', () => {
    const directory = createDirectory();

    fs.writeFileSync(path.join(directory, ALIASES_FILE_NAME), JSON.stringify({ swole: '💪', broken: 42, empty: '' }));

    expect(readAliases(directory)).toEqual({ swole: '💪' });
  });

  test('saving replaces an existing alias of the same name', () => {
    const directory = createDirectory();

    saveAlias(directory, 'swole', '💪');
    const aliases = saveAlias(directory, 'SWOLE', '🏋️');

    expect(aliases).toEqual({ swole: '🏋️' });
    expect(readAliases(directory)).toEqual(aliases);
  });

  test('removing an alias that is not there changes nothing and still works', () => {
    const directory = createDirectory();

    saveAlias(directory, 'swole', '💪');

    expect(removeAlias(directory, 'nope')).toEqual({ swole: '💪' });
    expect(removeAlias(directory, 'swole')).toEqual({});
    expect(readAliases(directory)).toEqual({});
  });
});
