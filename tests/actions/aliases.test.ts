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
  buildAddAliasHintResult,
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

  test('a name without an emoji asks for the emoji to be picked', () => {
    expect(parseAliasCommand('addalias swole')).toEqual({ kind: 'add-search', term: 'swole' });
    expect(parseAliasCommand('addalias big muscles')).toEqual({ kind: 'add-search', term: 'big muscles' });
    expect(parseAliasCommand('addalias')).toEqual({ kind: 'add-picker' });
  });

  test('removal names the alias, and asks when there is none', () => {
    expect(parseAliasCommand('removealias swole')).toEqual({ kind: 'remove', alias: 'swole' });
    expect(parseAliasCommand('removealias')).toEqual({ kind: 'remove-incomplete' });
  });
});

describe('buildAliasCommandResults', () => {
  /** A search that answers with two emoji, so the picker can be tested without emojilib. */
  const search = (term: string): { emoji: string, title: string, subtitle: string }[] =>
    term === 'nothing' ? [] : [{ emoji: '💪', title: 'Flexed Biceps', subtitle: 'muscle, strong' }];

  function results (command: Parameters<typeof buildAliasCommandResults>[0], directory: string | null) {
    return buildAliasCommandResults(command, paths(directory), search) ?? [];
  }

  test('an ordinary search produces no results from here', () => {
    expect(buildAliasCommandResults({ kind: 'none' }, paths(createSettingsDirectory()), search)).toBeNull();
  });

  test('a complete command offers to save, and writes nothing while typing', () => {
    const directory = createSettingsDirectory();
    const [result] = results({ kind: 'add', emoji: '💪', alias: 'Swole' }, directory);

    expect(result?.Title).toContain('swole');
    // The emoji arrives as the icon, not as a monochrome glyph inside the title.
    expect(result?.Subtitle).toContain('this emoji');
    expect(result?.IcoPath).toMatch(/^icons\\/);
    // A query is run per keystroke: saving here would leave `s`, `sw`, `swo` behind as aliases.
    expect(readAliases(directory)).toEqual({});
    expect(result?.JsonRPCAction).toEqual({ method: 'addalias', parameters: ['swole', '💪'] });
  });

  test('a name without an emoji becomes a picker that saves the name', () => {
    const [result] = results({ kind: 'add-search', term: 'swole' }, createSettingsDirectory());

    expect(result?.Title).toBe('Flexed Biceps');
    expect(result?.Subtitle).toContain('swole');
    expect(result?.IcoPath).toMatch(/^icons\\/);
    expect(result?.JsonRPCAction).toEqual({ method: 'addalias', parameters: ['swole', '💪'] });
  });

  test('a bare addalias shows the emoji list and pre-fills the command', () => {
    const [result] = results({ kind: 'add-picker' }, createSettingsDirectory());

    // No name typed yet, so the emoji comes first: Enter puts the command in the query box.
    expect(result?.JsonRPCAction).toEqual({
      method: 'Flow.Launcher.ChangeQuery',
      parameters: ['addalias 💪 ', true]
    });
  });

  test('a search with no matches shows nothing rather than inventing an emoji', () => {
    expect(results({ kind: 'add-search', term: 'nothing' }, createSettingsDirectory())).toEqual([]);
  });

  test('removing offers to remove, and writes nothing until Enter', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');

    const [result] = results({ kind: 'remove', alias: 'swole' }, directory);

    expect(result?.Title).toContain('swole');
    expect(result?.JsonRPCAction).toEqual({ method: 'removealias', parameters: ['swole'] });
    expect(readAliases(directory)).toEqual({ swole: '💪' });
  });

  test('listing shows the files first, then every alias', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');
    saveAlias(directory, 'shipit', '🚀');

    const listed = results({ kind: 'list' }, directory);

    expect(listed[0]?.Title).toBe('Open my aliases file');
    expect(listed[1]?.Title).toBe('Open the emoji database');
    expect(listed[2]?.Title).toContain('shipit');
    expect(listed[2]?.Subtitle).toContain('remove');
    expect(listed[3]?.Title).toContain('swole');
    expect(listed[2]?.JsonRPCAction).toEqual({ method: 'removealias', parameters: ['shipit'] });
  });

  test('an empty list explains how to make one', () => {
    const listed = results({ kind: 'list' }, createSettingsDirectory());

    expect(listed.at(-1)?.Title).toBe('No aliases yet');
    expect(listed.at(-1)?.Subtitle).toContain('addalias');
  });

  test('the two open-file entries use a Flow Launcher method it can resolve', () => {
    const listed = results({ kind: 'list' }, createSettingsDirectory());

    for (const result of listed.slice(0, 2)) {
      expect(result.JsonRPCAction?.method).toBe('Flow.Launcher.ShellRun');
      expect(result.JsonRPCAction?.parameters).toHaveLength(2);
    }
  });
});

describe('the context menu', () => {
  test('explains how to add an alias instead of trying to type for the user', () => {
    const [first] = buildContextMenu('💪', paths(createSettingsDirectory()));

    expect(first?.Title).toBe('Add an alias for this emoji');
    // Flow keeps this menu open while the query box filters its own entries, so a pre-filled
    // query is filtered away as soon as the user starts typing the name. The hint has no action.
    expect(first?.Subtitle).toContain('e addalias');
    expect(first?.JsonRPCAction).toBeUndefined();
  });

  test('offers to remove only the aliases of this emoji', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');
    saveAlias(directory, 'shipit', '🚀');

    const menu = buildContextMenu('💪', paths(directory));

    expect(menu.map((result) => result.Title)).toContain('Remove the alias “swole”');
    expect(menu.map((result) => result.Title)).not.toContain('Remove the alias “shipit”');
  });

  test('offers a copy-only action, for when Enter mode is paste', () => {
    const menu = buildContextMenu('💪', paths(createSettingsDirectory()));
    const copyOnly = menu.find((result) => result.Title === 'Copy only (no paste)');

    // Our own copy action, so the pick is recorded and the user gets a confirmation.
    expect(copyOnly?.JsonRPCAction).toEqual({ method: 'copy', parameters: ['💪', true] });
  });

  test('offers the file, even when there are no aliases yet', () => {
    const menu = buildContextMenu('💪', paths(createSettingsDirectory()));

    expect(menu.at(-1)?.Title).toBe('Open my aliases file');
  });

  test('explains itself instead of inventing an emoji when there is no ContextData', () => {
    const [first] = buildContextMenu(undefined, paths(createSettingsDirectory()));

    expect(first?.Title).toBe('No emoji attached to this result');
    expect(first?.JsonRPCAction).toBeUndefined();
  });

  test('offers no file entry when there is no settings folder', () => {
    const menu = buildContextMenu('💪', paths(null));

    // The hint and copy-only stay, because neither needs a file; a file entry would be a dead
    // link, so it is the only thing missing.
    expect(menu.map((result) => result.Title)).toEqual(['Add an alias for this emoji', 'Copy only (no paste)']);
    expect(menu[0]).toEqual(buildAddAliasHintResult('💪'));
  });
});
