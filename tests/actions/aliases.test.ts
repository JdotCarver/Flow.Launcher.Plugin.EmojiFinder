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
  buildAddAliasResult,
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

function paths (settingsDirectory: string | null): { settingsDirectory: string | null } {
  return { settingsDirectory };
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

  test('the emoji comes first, and the rest is the name', () => {
    expect(parseAliasCommand('addalias 💪 swole')).toEqual({ kind: 'add', emoji: '💪', alias: 'swole' });
  });

  test('a name in front of the emoji is not accepted, so no word means two things', () => {
    // "swole 💪" cannot be both a name and a search, and an emoji is never inferred from a name.
    expect(parseAliasCommand('addalias swole 💪')).toEqual({ kind: 'emoji-missing' });
  });

  test('a name with a space in it needs no quoting', () => {
    expect(parseAliasCommand('addalias 💪 big muscles')).toEqual({ kind: 'add', emoji: '💪', alias: 'big muscles' });
  });

  test('an emoji without a name asks for one', () => {
    expect(parseAliasCommand('addalias 💪')).toEqual({ kind: 'name-missing', emoji: '💪' });
  });

  test('a word without an emoji in front asks for the emoji, and never becomes a search', () => {
    expect(parseAliasCommand('addalias swole')).toEqual({ kind: 'emoji-missing' });
    expect(parseAliasCommand('addalias big muscles')).toEqual({ kind: 'emoji-missing' });
    expect(parseAliasCommand('addalias')).toEqual({ kind: 'emoji-missing' });
  });

  test('removal names the alias, and asks when there is none', () => {
    expect(parseAliasCommand('removealias swole')).toEqual({ kind: 'remove', alias: 'swole' });
    expect(parseAliasCommand('removealias')).toEqual({ kind: 'remove-incomplete' });
  });
});

describe('buildAliasCommandResults', () => {
  function results (command: Parameters<typeof buildAliasCommandResults>[0], directory: string | null, keyword = 'e') {
    return buildAliasCommandResults(command, paths(directory), keyword) ?? [];
  }

  test('an ordinary search produces no results from here', () => {
    expect(buildAliasCommandResults({ kind: 'none' }, paths(createSettingsDirectory()), 'e')).toBeNull();
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

  test("every command the plugin prints uses the installation's own keyword", () => {
    // `e` is only the default; the keyword can be changed in Flow's settings, and a sentence
    // that insists on `e` would hand out a command that goes nowhere.
    const [nameMissing] = results({ kind: 'name-missing', emoji: '💪' }, createSettingsDirectory(), 'emoji');
    const [emojiMissing] = results({ kind: 'emoji-missing' }, createSettingsDirectory(), 'emoji');
    const [removeMissing] = results({ kind: 'remove-incomplete' }, createSettingsDirectory(), 'emoji');
    const emptyList = results({ kind: 'list' }, createSettingsDirectory(), 'emoji').at(-1)!;

    expect(nameMissing.Subtitle).toBe('emoji addalias 💪 <name>');
    expect(emojiMissing.Subtitle).toContain('emoji addalias 💪 swole');
    expect(removeMissing.Subtitle).toContain('emoji removealias <name>');
    expect(removeMissing.Subtitle).toContain('emoji aliases');
    expect(emptyList.Subtitle).toContain('emoji addalias');
    // Nothing still assumes the default while claiming to speak for this install.
    expect([nameMissing, emojiMissing, removeMissing, emptyList].map(row => row.Subtitle).join(' '))
      .not.toMatch(/\be addalias|\be removealias|\be aliases/);
  });

  test('an emoji without a name shows one line asking for the name', () => {
    const all = results({ kind: 'name-missing', emoji: '💪' }, createSettingsDirectory());

    // One line, not a list: Enter on a list row could only guess which part of the command it was.
    expect(all).toHaveLength(1);
    expect(all[0].Title).toBe('Now type the name');
    expect(all[0].Subtitle).toContain('e addalias 💪 <name>');
    expect(all[0].JsonRPCAction).toBeUndefined();
  });

  test('a word without an emoji in front gets one line explaining the order', () => {
    const all = results({ kind: 'emoji-missing' }, createSettingsDirectory());

    expect(all).toHaveLength(1);
    expect(all[0].Title).toBe('Type the emoji first, then the name');
    expect(all[0].Subtitle).toContain('e addalias 💪 swole');
    // An emoji can be found by name and pasted: search `e`, Enter copies it.
    expect(all[0].Subtitle).toContain('paste');
    // Nothing is selectable, so no keystroke can save a name to an emoji the plugin guessed.
    expect(all[0].JsonRPCAction).toBeUndefined();
  });

  test('removing offers to remove, and writes nothing until Enter', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');

    const [result] = results({ kind: 'remove', alias: 'swole' }, directory);

    expect(result?.Title).toContain('swole');
    expect(result?.JsonRPCAction).toEqual({ method: 'removealias', parameters: ['swole'] });
    expect(readAliases(directory)).toEqual({ swole: '💪' });
  });

  test('listing shows the file first, then every alias', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');
    saveAlias(directory, 'shipit', '🚀');

    const listed = results({ kind: 'list' }, directory);

    expect(listed[0]?.Title).toBe('Open my aliases file');
    expect(listed[1]?.Title).toContain('shipit');
    expect(listed[1]?.Subtitle.toLowerCase()).toContain('remove');
    expect(listed[2]?.Title).toContain('swole');
    expect(listed[1]?.JsonRPCAction).toEqual({ method: 'removealias', parameters: ['shipit'] });
    // The emoji database is not offered: it ships with the plugin and updates replace it, so
    // hand-edits there would vanish and turn into bug reports.
    expect(listed.map((result) => result.Title)).not.toContain('Open the emoji database');
  });

  test('an empty list explains how to make one', () => {
    const listed = results({ kind: 'list' }, createSettingsDirectory());

    expect(listed.at(-1)?.Title).toBe('No aliases yet');
    expect(listed.at(-1)?.Subtitle).toContain('addalias');
  });

  test('opening the file is our own action, so the file can be created first', () => {
    const listed = results({ kind: 'list' }, createSettingsDirectory());

    // ShellRun cannot open a data file - it starts the file name as a program - and the file has
    // to exist before it can be opened, which is a write only an action may do.
    expect(listed[0]?.JsonRPCAction).toEqual({ method: 'openaliases', parameters: [] });
  });
});

describe('the context menu', () => {
  test('leads with copy-only, then add, then removal, then the file', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');

    expect(buildContextMenu('💪', paths(directory), 'e').map((result) => result.Title)).toEqual([
      'Copy only',
      'Add an alias for this emoji',
      'Remove alias “swole”',
      'Open my aliases file'
    ]);
  });

  test('copies the finished add command, because nothing can type it for the user', () => {
    const [copyOnly, add] = buildContextMenu('💪', paths(createSettingsDirectory()), 'e');

    // Our own copy action, so the pick is recorded and the user gets a confirmation.
    expect(copyOnly.JsonRPCAction).toEqual({ method: 'copy', parameters: ['💪', true] });
    // ChangeQuery inside the menu only re-filters the menu, and returning from it restores the
    // pre-menu text, so the command is handed over on the clipboard instead.
    expect(add.JsonRPCAction).toEqual({
      method: 'Flow.Launcher.CopyToClipboard',
      parameters: ['e addalias 💪 ', false, true]
    });
    expect(add.Subtitle.toLowerCase()).toContain('paste');
  });

  test('uses the keyword from the manifest, not a hard-coded e', () => {
    const [, add] = buildContextMenu('💪', paths(createSettingsDirectory()), 'emoji');

    expect(add.JsonRPCAction?.parameters?.[0]).toBe('emoji addalias 💪 ');
  });

  test('offers to remove only the aliases of this emoji', () => {
    const directory = createSettingsDirectory();

    saveAlias(directory, 'swole', '💪');
    saveAlias(directory, 'shipit', '🚀');

    const menu = buildContextMenu('💪', paths(directory), 'e');

    expect(menu.map((result) => result.Title)).toContain('Remove alias “swole”');
    expect(menu.map((result) => result.Title)).not.toContain('Remove alias “shipit”');
  });

  test('offers the file, even when there are no aliases yet', () => {
    const menu = buildContextMenu('💪', paths(createSettingsDirectory()), 'e');

    expect(menu.at(-1)?.Title).toBe('Open my aliases file');
  });

  test('explains itself instead of inventing an emoji when there is no ContextData', () => {
    const [first] = buildContextMenu(undefined, paths(createSettingsDirectory()), 'e');

    expect(first?.Title).toBe('No emoji attached to this result');
    expect(first?.JsonRPCAction).toBeUndefined();
  });

  test('offers no file entry when there is no settings folder', () => {
    const menu = buildContextMenu('💪', paths(null), 'e');

    // Copy and add stay, because neither needs a file; a file entry would be a dead link, so it
    // is the only thing missing.
    expect(menu.map((result) => result.Title)).toEqual(['Copy only', 'Add an alias for this emoji']);
    expect(menu[1]).toEqual(buildAddAliasResult('💪', 'e'));
  });
});
