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
  ensureAliasesFile,
  readPluginName,
  readActionKeyword,
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

describe('readActionKeyword', () => {
  test('reads the keyword from the plugin manifest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ ActionKeyword: 'emoji' }));

    expect(readActionKeyword(directory)).toBe('emoji');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('falls back to e when the manifest is missing or says nothing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));

    // A missing manifest must not make the context menu throw; e is what plugin.json ships.
    expect(readActionKeyword(directory)).toBe('e');

    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ ActionKeyword: '  ' }));
    expect(readActionKeyword(directory)).toBe('e');

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('this plugin\'s own manifest declares e', () => {
    // The subtitle shows the command, so the constant and the file have to agree.
    expect(readActionKeyword()).toBe('e');
  });
});

describe('ensureAliasesFile', () => {
  test('creates the file with its guidance entry when it is not there yet', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aliases-'));
    const file = ensureAliasesFile(directory);

    // A fresh install has no file: nothing has been saved. Opening it has to land in a file that
    // exists and explains the format, or hand-editing starts with a puzzle.
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;

    // Three lines, three jobs: what the file is for, the warning worth having, and an example.
    expect(Object.keys(written)).toEqual(['_HowToUse', '_Note', '_examplealias']);
    expect(written._HowToUse).toContain('manually edit');
    expect(written._Note).toContain('emoji database');
    expect(written._examplealias).toBe('💪');

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('never overwrites a file that already has aliases in it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aliases-'));

    saveAlias(directory, 'swole', '💪');
    ensureAliasesFile(directory);

    expect(readAliases(directory)).toEqual({ swole: '💪' });

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('the guidance entry is not an alias, and survives the first save', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aliases-'));

    ensureAliasesFile(directory);
    saveAlias(directory, 'swole', '💪');

    // It must not show up in the list or in find()'s alias map...
    expect(readAliases(directory)).toEqual({ swole: '💪' });
    // ...and saving must not delete the only explanation of the format.
    const written = JSON.parse(fs.readFileSync(path.join(directory, ALIASES_FILE_NAME), 'utf8')) as Record<string, string>;

    expect(written._HowToUse).toBeDefined();
    expect(written.swole).toBe('💪');

    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe('resolvePluginSettingsDirectory', () => {
  test('finds the settings folder of an installed Flow Launcher', () => {
    const root = createDirectory();
    const pluginDirectory = path.join(root, 'FlowLauncher', 'Plugins', 'Flow.Launcher.Plugin.EmojiFinder');

    fs.mkdirSync(pluginDirectory, { recursive: true });

    // Flow names a non-.NET plugin's settings folder after the plugin, not after its ID
    // (PluginManager.UpdatePluginDirectory). A GUID folder next to a tidy "Emoji Finder" one was
    // this plugin's mistake, and Flow never read what was written there.
    expect(resolvePluginSettingsDirectory(pluginDirectory)).toBe(
      path.join(root, 'FlowLauncher', 'Settings', 'Plugins', 'Emoji Finder')
    );
  });

  test('finds the settings folder of a portable Flow Launcher the same way', () => {
    const root = createDirectory();
    const pluginDirectory = path.join(root, 'Flow', 'UserData', 'Plugins', 'Flow.Launcher.Plugin.EmojiFinder');

    fs.mkdirSync(pluginDirectory, { recursive: true });

    expect(resolvePluginSettingsDirectory(pluginDirectory)).toBe(
      path.join(root, 'Flow', 'UserData', 'Settings', 'Plugins', 'Emoji Finder')
    );
  });

  test('the folder name is this plugin\'s own Name, not a constant that can drift', () => {
    const root = createDirectory();
    const pluginDirectory = path.join(root, 'FlowLauncher', 'Plugins', 'Flow.Launcher.Plugin.EmojiFinder');

    fs.mkdirSync(pluginDirectory, { recursive: true });
    fs.writeFileSync(path.join(pluginDirectory, 'plugin.json'), JSON.stringify({ Name: 'Emoji Finder', ActionKeyword: 'e' }));

    expect(readPluginName(pluginDirectory)).toBe('Emoji Finder');
    expect(resolvePluginSettingsDirectory(pluginDirectory)).toBe(
      path.join(root, 'FlowLauncher', 'Settings', 'Plugins', 'Emoji Finder')
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
