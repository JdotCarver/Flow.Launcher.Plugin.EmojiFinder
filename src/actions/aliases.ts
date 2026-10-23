// src/actions/aliases.ts
//
// The user's own names for emoji, as a typed command and as right-arrow menu items.
//
// Why a command and a menu, and not a text box: Flow Launcher's plugin API has no prompt for a
// string (`IPublicAPI` offers ShowMsg, ShowMsgWithButton and ChangeQuery, and nothing that reads
// input). A JS plugin can, however, add context menu items - `JsonRPCPluginBase.LoadContextMenus`
// calls our script with method "context_menu" - so the flow is:
//
//   right arrow on an emoji -> "Add an alias for 💪" -> the query box is pre-filled with
//   "e addalias 💪 " and the caret at the end -> type "swole" -> Enter.
//
// The command can also be typed outright, which is faster for people who know it:
//
//   e addalias swole 💪        (either order: the emoji is recognised on its own)
//   e removealias swole
//   e aliases                  (list them, plus the files, with remove-on-Enter)
//
// Both paths end in the same save call, and aliases then behave as extra names in `find()`.

import { ALIASES_FILE_NAME, readAliases } from '../utils/pluginData.js';
import type { JsonRpcAction, Result } from '../types.js';

/** How many emoji the picker offers at once. The same ceiling the search uses. */
const PICKER_LIMIT = 25;

/** A token that looks like an emoji: pictographic, possibly with joiners and selectors. */
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

/**
 * Whether the user typed one of our alias commands.
 *
 * The first word decides, and it has to match exactly: "alias" is a plausible emoji search term,
 * so a prefix match would hijack an ordinary query.
 */
export type AliasCommand =
  | { kind: 'none' }
  /** Both parts given: `addalias swole 💪`. */
  | { kind: 'add', emoji: string, alias: string }
  /** An emoji but no name yet: `addalias 💪`. */
  | { kind: 'add-incomplete', emoji: string }
  /** A name but no emoji yet: `addalias swole` - the emoji is picked from the list. */
  | { kind: 'add-search', term: string }
  /** Neither: `addalias` alone. */
  | { kind: 'add-picker' }
  | { kind: 'remove', alias: string }
  | { kind: 'remove-incomplete' }
  | { kind: 'list' };

/**
 * Reads a typed alias command, or reports that this is an ordinary search.
 *
 * The emoji can be given before or after the name - `addalias swole 💪` and
 * `addalias 💪 swole` are the same command - because the pre-filled query puts the emoji first
 * and people will type it either way. Everything that is not the emoji becomes the name, so a
 * name with a space in it works without quoting.
 */
export function parseAliasCommand (input: string): AliasCommand {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const [command = ''] = tokens;

  if (command === 'aliases') {
    return { kind: 'list' };
  }

  if (command === 'removealias') {
    const alias = tokens.slice(1).join(' ');

    return alias === '' ? { kind: 'remove-incomplete' } : { kind: 'remove', alias };
  }

  if (command !== 'addalias') {
    return { kind: 'none' };
  }

  const rest = tokens.slice(1);
  const emoji = rest.find((token) => EMOJI_PATTERN.test(token));

  if (emoji === undefined) {
    const term = rest.join(' ');

    return term === '' ? { kind: 'add-picker' } : { kind: 'add-search', term };
  }

  const alias = rest.filter((token) => token !== emoji).join(' ');

  return alias === '' ? { kind: 'add-incomplete', emoji } : { kind: 'add', emoji, alias };
}

/** An action that opens a file with whatever the user has associated with it. */
function openFileAction (filePath: string): JsonRpcAction {
  // ShellRun(cmd, filename): with an empty command the file name is started on its own, which
  // is Windows' "open with the default program". Two strings, so IPublicAPI.GetMethod's exact
  // type match finds it.
  return { method: 'Flow.Launcher.ShellRun', parameters: ['', filePath] };
}

/**
 * The menu entry that explains how to add an alias.
 *
 * It cannot do the adding itself: Flow Launcher keeps the context menu open while the query box
 * filters the menu's own entries, so a pre-filled query disappears the moment the user types the
 * name. An entry that only needs typing is the honest version.
 */
export function buildAddAliasHintResult (emoji: string): Result {
  return {
    Title: 'Add an alias for this emoji',
    Subtitle: `Type: e addalias ${emoji} <name> - or e addalias <name> and pick the emoji`,
    IcoPath: 'img\\app.png'
  };
}

/**
 * What an alias command shows.
 *
 * Queries never write. Flow Launcher runs our script once per keystroke, so saving while the
 * user types would save `s`, then `sw`, then `swo`, ... - and every prefix would stay behind as
 * an alias. Everything that changes a file is an action, which only runs when Enter is pressed.
 *
 * @param command A parsed alias command.
 * @param paths Where the files are.
 * @param search Finds emoji for the picker. Injected so this module does not import the hot path.
 */
export function buildAliasCommandResults (
  command: AliasCommand,
  paths: { settingsDirectory: string | null, emojiDatabase: string },
  search: (term: string, limit: number) => { emoji: string, title: string, subtitle: string }[]
): Result[] | null {
  if (command.kind === 'none') {
    return null;
  }

  if (command.kind === 'add') {
    const alias = command.alias.trim().toLowerCase();

    return [{
      Title: `Save “${alias}” for ${command.emoji}`,
      Subtitle: 'Press Enter to save this alias',
      IcoPath: 'img\\app.png',
      JsonRPCAction: { method: 'addalias', parameters: [alias, command.emoji] }
    }];
  }

  if (command.kind === 'add-incomplete') {
    return [{
      Title: `Type the name for ${command.emoji}`,
      Subtitle: `e addalias ${command.emoji} <name>`,
      IcoPath: 'img\\app.png'
    }];
  }

  if (command.kind === 'add-search' || command.kind === 'add-picker') {
    return pickerResults(command, search);
  }

  if (command.kind === 'remove') {
    return [{
      Title: `Remove the alias “${command.alias}”`,
      Subtitle: 'Press Enter to remove it',
      IcoPath: 'img\\app.png',
      JsonRPCAction: { method: 'removealias', parameters: [command.alias] }
    }];
  }

  if (command.kind === 'remove-incomplete') {
    return [{
      Title: 'Type the alias to remove',
      Subtitle: 'e removealias <name> - or e aliases to see them all',
      IcoPath: 'img\\app.png'
    }];
  }

  return listingResults(paths);
}

/**
 * The emoji to attach a name to.
 *
 * `e addalias swole` searches for "swole" like an ordinary query, so the user can find the emoji
 * the way they always do, and Enter saves the name they already typed. With no name yet
 * (`e addalias`) the plain list is shown and Enter pre-fills the command instead - picking the
 * emoji first is the only order that works when the name is not typed yet.
 */
function pickerResults (command: { kind: 'add-search', term: string } | { kind: 'add-picker' }, search: (term: string, limit: number) => { emoji: string, title: string, subtitle: string }[]): Result[] {
  const term = command.kind === 'add-search' ? command.term : '';
  const emoji = search(term, PICKER_LIMIT);

  return emoji.map(({ emoji: candidate, title, subtitle }) => (command.kind === 'add-search'
    ? {
        Title: `${candidate}  ${title}`,
        Subtitle: `Press Enter to make “${term}” an alias for ${candidate}`,
        IcoPath: 'img\\app.png',
        JsonRPCAction: { method: 'addalias', parameters: [term, candidate] }
      }
    : {
        Title: `${candidate}  ${title}`,
        Subtitle: `${subtitle} - Enter, then type the name`,
        IcoPath: 'img\\app.png',
        JsonRPCAction: { method: 'Flow.Launcher.ChangeQuery', parameters: [`addalias ${candidate} `, true] }
      }));
}

/**
 * Everything the user can look at: their aliases, and the two files behind the feature.
 *
 * Removing is Enter on a listed alias. That is blunt, so the title says what Enter does; the
 * settings page says where the file is for anyone who would rather edit it by hand.
 */
function listingResults (paths: { settingsDirectory: string | null, emojiDatabase: string }): Result[] {
  const aliases = paths.settingsDirectory === null ? {} : readAliases(paths.settingsDirectory);
  const results: Result[] = [
    {
      Title: 'Open my aliases file',
      Subtitle: paths.settingsDirectory === null ? 'Could not find the settings folder' : `${paths.settingsDirectory}\\${ALIASES_FILE_NAME}`,
      IcoPath: 'img\\app.png',
      ...(paths.settingsDirectory === null ? {} : { JsonRPCAction: openFileAction(`${paths.settingsDirectory}\\${ALIASES_FILE_NAME}`) })
    },
    {
      Title: 'Open the emoji database',
      Subtitle: 'The file that comes with the plugin, if you want to add aliases by hand',
      IcoPath: 'img\\app.png',
      JsonRPCAction: openFileAction(paths.emojiDatabase)
    }
  ];

  const entries = Object.entries(aliases).sort(([first], [second]) => first.localeCompare(second));

  if (entries.length === 0) {
    results.push({
      Title: 'No aliases yet',
      Subtitle: 'Type: e addalias <name> and pick the emoji, or e addalias <name> <emoji>',
      IcoPath: 'img\\app.png'
    });

    return results;
  }

  for (const [alias, emoji] of entries) {
    results.push({
      Title: `${emoji}  ${alias}`,
      Subtitle: 'Press Enter to remove this alias',
      IcoPath: 'img\\app.png',
      JsonRPCAction: { method: 'removealias', parameters: [alias] }
    });
  }

  return results;
}

/**
 * The right-arrow menu for one emoji.
 *
 * @param emoji The emoji the selected result stands for.
 * @param paths Where the files are.
 */
export function buildContextMenu (
  emoji: string | undefined,
  paths: { settingsDirectory: string | null, emojiDatabase: string }
): Result[] {
  // Flow hands back whatever ContextData the result carried. Results from an older build (or
  // any result without it) arrive as undefined, and a menu that says "Add an alias for
  // undefined" is worse than one that explains itself.
  if (typeof emoji !== 'string' || emoji === '') {
    return [{
      Title: 'No emoji attached to this result',
      Subtitle: 'Restart Flow Launcher so the plugin reloads, then try again',
      IcoPath: 'img\\app.png'
    }];
  }

  const aliases = paths.settingsDirectory === null ? {} : readAliases(paths.settingsDirectory);
  const own = Object.entries(aliases).filter(([, value]) => value === emoji);

  // The first entry explains how to add one instead of trying to do it: adding needs a name
  // typed, and Flow Launcher keeps this menu open while the query box filters the menu's own
  // entries, so a pre-filled query is filtered away as soon as the user types.
  const menu: Result[] = [buildAddAliasHintResult(emoji)];

  for (const [alias] of own) {
    menu.push({
      Title: `Remove alias “${alias}”`,
      Subtitle: `${emoji} would stop answering to it`,
      IcoPath: 'img\\app.png',
      JsonRPCAction: { method: 'removealias', parameters: [alias] }
    });
  }

  if (paths.settingsDirectory !== null) {
    menu.push({
      Title: 'Open my aliases file',
      Subtitle: `Opens your ${ALIASES_FILE_NAME} located in the plugin's settings folder`,
      IcoPath: 'img\\app.png',
      JsonRPCAction: openFileAction(`${paths.settingsDirectory}\\${ALIASES_FILE_NAME}`)
    });
  }

  return menu;
}
