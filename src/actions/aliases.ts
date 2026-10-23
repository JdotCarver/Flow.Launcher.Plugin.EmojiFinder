// src/actions/aliases.ts
//
// The user's own names for emoji, as a typed command and as right-arrow menu items.
//
// Why a command and a menu, and not a text box: Flow Launcher's plugin API has no prompt for a
// string (`IPublicAPI` offers ShowMsg, ShowMsgWithButton and ChangeQuery, and nothing that reads
// input). A JS plugin can, however, add context menu items - `JsonRPCPluginBase.LoadContextMenus`
// calls our script with method "context_menu".
//
// The grammar is deliberately strict: the emoji comes first, then the name.
//
//   e addalias 💪 swole        save "swole" for 💪
//   e removealias swole        remove it
//   e aliases                  list them, plus the files, with remove-on-Enter
//
// Both paths end in the same save call, and aliases then behave as extra names in `find()`.
//
// Why the emoji comes first, and why nothing is ever guessed:
//
// An earlier version accepted the name and the emoji in either order, and searched for the emoji
// when it could not find one. That made a single word mean two things at once - in
// `e addalias muscle`, "muscle" was both the name to save and the search term for the emoji - and
// the same keystrokes could mean something different depending on what the user had already
// aliased. A word now means exactly one thing: it is a name, and a name without an emoji in front
// of it gets one line explaining the order instead of a list to choose from.
//
// Adding an alias starts from the emoji, and the fastest way to get the emoji into the command is
// Tab: every emoji result carries `AutoCompleteText` = `e addalias 💪 `, and Flow's autocomplete
// replaces the query with it. The right-arrow menu cannot do that for the user - a menu action can
// call one Flow method, and leaving the menu takes a second one - so its entry explains the
// keystrokes instead of faking them. See docs/FRECENCY_AND_ALIASES.md for the measurements.

import { ALIASES_FILE_NAME, readAliases } from '../utils/pluginData.js';
import { getIconFileName } from '../utils/utils.js';
import type { JsonRpcAction, Result } from '../types.js';

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
  /** Emoji and name given: `addalias 💪 swole`. */
  | { kind: 'add', emoji: string, alias: string }
  /** An emoji but no name yet: `addalias 💪`. */
  | { kind: 'name-missing', emoji: string }
  /** Words but no emoji in front: `addalias swole`, or `addalias`. */
  | { kind: 'emoji-missing' }
  | { kind: 'remove', alias: string }
  | { kind: 'remove-incomplete' }
  | { kind: 'list' };

/**
 * Reads a typed alias command, or reports that this is an ordinary search.
 *
 * Emoji first, then everything after it is the name - so a name with a space in it works without
 * quoting. If the first word after `addalias` is not an emoji, the command is incomplete, whatever
 * else was typed: guessing would make the same word mean two things.
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

  const [first, ...rest] = tokens.slice(1);

  if (first === undefined || !EMOJI_PATTERN.test(first)) {
    return { kind: 'emoji-missing' };
  }

  const alias = rest.join(' ');

  return alias === '' ? { kind: 'name-missing', emoji: first } : { kind: 'add', emoji: first, alias };
}

/**
 * The icon for one emoji.
 *
 * The emoji's own PNG, in colour. Emoji written into a Title render as monochrome outline
 * glyphs in Flow's result list, and repeating the emoji in the title and the subtitle shows it
 * twice - once as text, once as an icon - which reads as a rendering bug.
 */
function emojiIcon (emoji: string): string {
  return getIconFileName(emoji) ?? 'img\\app.png';
}

/** An action that opens a file with whatever the user has associated with it. */
function openFileAction (filePath: string): JsonRpcAction {
  // ShellRun(cmd, filename): with an empty command the file name is started on its own, which
  // is Windows' "open with the default program". Two strings, so IPublicAPI.GetMethod's exact
  // type match finds it.
  return { method: 'Flow.Launcher.ShellRun', parameters: ['', filePath] };
}

/**
 * The menu entry that points at the add-an-alias command.
 *
 * It cannot do the job itself, and the reason is worth stating because it looks possible:
 *
 *   `Flow.Launcher.ChangeQuery` sets the query text but does NOT leave the context menu. Flow
 *   runs `Query()`, sees that a context menu is selected, and re-filters the menu instead of
 *   querying (`MainViewModel.Query`). A single action may call exactly one `Flow.Launcher.*`
 *   method (`JsonRPCPlugin.ExecuteResultAsync`), and leaving the menu takes a second call
 *   (`BackToQueryResults`). Measured on the machine: the command appeared in the box, the menu
 *   emptied, and Enter did nothing.
 *
 * So the entry teaches the two ways that do work: pressing Tab on the emoji fills the command in
 * (`Result.AutoCompleteText`), and Enter copies the emoji if it is pasted instead.
 *
 * @param emoji The emoji the selected result stands for.
 * @param actionKeyword The word that routes the query back to this plugin.
 */
export function buildAddAliasResult (emoji: string, actionKeyword: string): Result {
  return {
    Title: 'Add alias',
    Subtitle: `Esc, then Tab: fills in “${actionKeyword} addalias ${emoji} ”`,
    IcoPath: emojiIcon(emoji)
  };
}

/**
 * What an alias command shows.
 *
 * Queries never write. Flow Launcher runs our script once per keystroke, so saving while the
 * user types would save `s`, then `sw`, then `swo`, ... - and every prefix would stay behind as
 * an alias. Everything that changes a file is an action, which only runs when Enter is pressed.
 *
 * Every incomplete command shows one line that names the missing part, never a list to choose
 * from: a list invites Enter, and Enter on a list row would have to guess which part it meant.
 *
 * @param command A parsed alias command.
 * @param paths Where the files are.
 */
export function buildAliasCommandResults (
  command: AliasCommand,
  paths: { settingsDirectory: string | null, emojiDatabase: string }
): Result[] | null {
  if (command.kind === 'none') {
    return null;
  }

  if (command.kind === 'add') {
    const alias = command.alias.trim().toLowerCase();

    return [{
      Title: `Save the alias “${alias}”`,
      Subtitle: `Enter to save it. “${alias}” will find this emoji.`,
      IcoPath: emojiIcon(command.emoji),
      JsonRPCAction: { method: 'addalias', parameters: [alias, command.emoji] }
    }];
  }

  if (command.kind === 'name-missing') {
    return [{
      Title: 'Now type the name',
      Subtitle: `e addalias ${command.emoji} <name>`,
      IcoPath: emojiIcon(command.emoji)
    }];
  }

  if (command.kind === 'emoji-missing') {
    return [{
      Title: 'Type the emoji first, then the name',
      Subtitle: 'e addalias 💪 swole (search e, press Enter to copy an emoji, paste it here)',
      IcoPath: 'img\\app.png'
    }];
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
      Subtitle: 'Type: e addalias <emoji> <name>, for example e addalias 💪 swole',
      IcoPath: 'img\\app.png'
    });

    return results;
  }

  for (const [alias, emoji] of entries) {
    results.push({
      Title: alias,
      Subtitle: 'Enter to remove this alias. It finds the emoji shown.',
      IcoPath: emojiIcon(emoji),
      JsonRPCAction: { method: 'removealias', parameters: [alias] }
    });
  }

  return results;
}

/**
 * The right-arrow menu for one emoji.
 *
 * Order is deliberate: the two things a person reaches for most (copy this emoji, name it) come
 * first, then the removal entries for this emoji, then the file.
 *
 * Flow Launcher appends two entries of its own after ours - "Set as topmost in this query" and
 * "<plugin name>" - for every plugin result. They are added by Flow after its plugins have
 * answered (`MainViewModel.QueryContextMenu`), so no plugin can remove them.
 *
 * @param emoji The emoji the selected result stands for.
 * @param paths Where the files are.
 * @param actionKeyword The word that routes a query back to this plugin.
 */
export function buildContextMenu (
  emoji: string | undefined,
  paths: { settingsDirectory: string | null, emojiDatabase: string },
  actionKeyword: string
): Result[] {
  // Flow hands back whatever ContextData the result carried. Results from an older build (or
  // any result without it) arrive as undefined, and a menu that says "Add alias for undefined"
  // is worse than one that explains itself.
  if (typeof emoji !== 'string' || emoji === '') {
    return [{
      Title: 'No emoji attached to this result',
      Subtitle: 'Restart Flow Launcher so the plugin reloads, then try again',
      IcoPath: 'img\\app.png'
    }];
  }

  const aliases = paths.settingsDirectory === null ? {} : readAliases(paths.settingsDirectory);
  const own = Object.entries(aliases).filter(([, value]) => value === emoji);

  // Copy-only, for anyone whose Enter mode is Paste Mode: the same emoji, without the Ctrl+V.
  // It runs our own copy action, which is what records the pick and shows the confirmation.
  const menu: Result[] = [{
    Title: 'Copy only',
    Subtitle: 'Copy this emoji to the clipboard',
    IcoPath: emojiIcon(emoji),
    JsonRPCAction: { method: 'copy', parameters: [emoji, true] }
  }];

  menu.push(buildAddAliasResult(emoji, actionKeyword));

  for (const [alias] of own) {
    menu.push({
      Title: `Remove alias “${alias}”`,
      Subtitle: 'This emoji would stop answering to it',
      IcoPath: emojiIcon(emoji),
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
