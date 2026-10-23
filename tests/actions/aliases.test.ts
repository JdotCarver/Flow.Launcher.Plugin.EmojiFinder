// tests/actions/aliases.test.ts
//
// The alias command and the right-arrow menu. The rules that matter: the command only fires on
// an exact first word (so an ordinary search for "alias" is not hijacked), the emoji can come
// before or after the name, and every menu item tells Flow Launcher to do something it can
// actually resolve.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildAddAliasMenuResult,
  buildAliasCommandResults,
  buildContextMenu,
  parseAliasCommand
} from '../../src/actions/aliases.js';
import { readAliases, saveAlias } from '../../src/utils/pluginData.js';

const temporaryDirectories: string[] = [];

function createSettingsDirectory (): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aliases-test-'));

  temporaryDirectories.push(directory);

  return directory;
}

function paths (settingsDirectory: string | null): { settingsDirectory: string | null, emojiDatabase: string } {
  return { settingsDirectory, emojiDatabase: 'C:\\Plugin\\node_modules\\emojilib\\dist\\emoji-en-US.json' };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('parseAliasCommand', () => {
  test('an ordinary search is not a command', () => {
    expect(parseAliasCommand('smile')).toEqual({ kind: 'none' });
    expect(parseAliasCommand('')).toEqual({ kind: 'none' });
    // Exact first word only: a prefix match would hijack these searches.
    expect(parseAliasCommand('aliases oh no')).toEqual({ kind: 'list' });
    expect(parseAliasCommand('alias smile')).toEqual({ kind: 'none' });
    expect(parseAliasCommand('addaliases')).toEqual({ kind: 'none' });
  });

  test('the emoji can come before or after the name', () => {
    expect(parseAliasCommand('addalias swole 💪')).toEqual({ kind: 'add', emoji: '💪', alias: 'swole' });
    expect(parseAliasCommand('addalias 💪 swole')).toEqual({ kind: 'add', emoji: '💪', alias: 'swole' });
  });

  test('a name with a space in it needs no quoting', () => {
    expect(parseAliasCommand('addalias 💪 big muscles')).toEqual({ kind: 'add', emoji: '💪', alias: 'big muscles' });
  });

  test('an emoji without a name asks for one', () => {
    expect(parseAliasCommand('addalias 💪')).toEqual({ kind: 'add-incomplete', emoji: '💪' });
  });

  test('a name without an emoji is not a command at all', () => {
    expect(parseAliasCommand('addalias swole')).toEqual({ kind: 'none' });
  });

  test('removal names the alias, and asks when there is none', () => {
    expect(parseAliasCommand('removealias swole')).toEqual({ kind: 'remove', alias: 'swole' });
    expect(parseAliasCommand('removealias')).toEqual({ kind: 'remove-incomplete' });
  });
});

describe('buildAliasCommandResults', () => {
  test('an ordinary search produces no results from here', () => {
    expect(buildAliasCommandResults({ kind: 'none' }, paths(createSettingsDirectory()))).toBeNull();
  });

  test('saving an alias writes it and confirms which emoji it points at', () => {
    const directory = createSettingsDirectory();
    const results = buildAliasCommandResults({ kind: 'add', emoji: '💪', alias: 'Swole' }, paths(directory)) ?? [];

    expect(results).toHaveLength(1);
    expect(results[0]?.Title).toContain('💪');
    expect(results[0]?.Title).toContain('swole');
    // The confirmation is not a dead end: Enter copies the emoji it is about.
    expect(results[0]?.JsonRPCAction?.parameters[0]).toBe('💪');
    expect(readAliases(directory)).toEqual({ swole: '💪' });
  });

  test('saving with no settings folder says so instead of throwing', () => {
    const results = buildAliasCommandResults({ kind: 'add', emoji: '💪', alias: 'swole' }, paths(null)) ?? [];

    expect(results).toHaveLength(1);
    expect(results[0]?.Title).toContain('💪');
  });

  test('removing an alias writes the file', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');

    const results = buildAliasCommandResults({ kind: 'remove', alias: 'swole' }, paths(directory)) ?? [];

    expect(results[0]?.Title).toContain('removed');
    expect(readAliases(directory)).toEqual({});
  });

  test('listing shows the files first, then every alias', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');
    saveAlias(directory, 'shipit', '🚀');

    const results = buildAliasCommandResults({ kind: 'list' }, paths(directory)) ?? [];

    expect(results[0]?.Title).toBe('Open your aliases file');
    expect(results[1]?.Title).toBe('Open the emoji database');
    // Sorted by alias name, and Enter removes - the title has to say so.
    expect(results[2]?.Title).toContain('shipit');
    expect(results[2]?.Subtitle).toContain('remove');
    expect(results[3]?.Title).toContain('swole');
    expect(results[2]?.JsonRPCAction).toEqual({ method: 'removealias', parameters: ['shipit'] });
  });

  test('an empty list explains how to make one', () => {
    const results = buildAliasCommandResults({ kind: 'list' }, paths(createSettingsDirectory())) ?? [];

    expect(results.at(-1)?.Title).toBe('No aliases yet');
    expect(results.at(-1)?.Subtitle).toContain('right arrow');
  });

  test('the two open-file entries use a Flow Launcher method it can resolve', () => {
    const results = buildAliasCommandResults({ kind: 'list' }, paths(createSettingsDirectory())) ?? [];

    // ShellRun(cmd, filename): two strings, so IPublicAPI.GetMethod's exact type match finds it.
    for (const result of results.slice(0, 2)) {
      expect(result.JsonRPCAction?.method).toBe('Flow.Launcher.ShellRun');
      expect(result.JsonRPCAction?.parameters).toHaveLength(2);
    }
  });
});

describe('the context menu', () => {
  test('offers to add an alias, and pre-fills the query box with the emoji', () => {
    const [first] = buildContextMenu('💪', paths(createSettingsDirectory()));

    expect(first?.Title).toContain('Add an alias');
    // ChangeQuery(string, bool): two arguments, because optional parameters are invisible to
    // Flow's reflection lookup.
    expect(first?.JsonRPCAction).toEqual({
      method: 'Flow.Launcher.ChangeQuery',
      parameters: ['addalias 💪 ', true]
    });
  });

  test('offers to remove only the aliases of this emoji', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');
    saveAlias(directory, 'shipit', '🚀');

    const menu = buildContextMenu('💪', paths(directory));

    expect(menu.map((result) => result.Title)).toContain('Remove alias “swole”');
    expect(menu.map((result) => result.Title)).not.toContain('Remove alias “shipit”');
  });

  test('offers the file, even when there are no aliases yet', () => {
    const menu = buildContextMenu('💪', paths(createSettingsDirectory()));

    expect(menu.at(-1)?.Title).toBe('Open your aliases file');
  });

  test('explains itself instead of inventing an emoji when there is no ContextData', () => {
    const [first] = buildContextMenu(undefined, paths(createSettingsDirectory()));

    expect(first?.Title).toBe('No emoji attached to this result');
    expect(first?.JsonRPCAction).toBeUndefined();
  });

  test('says nothing about files when there is no settings folder', () => {
    const menu = buildContextMenu('💪', paths(null));

    expect(menu).toHaveLength(1);
    expect(menu[0]).toEqual(buildAddAliasMenuResult('💪'));
  });
});
