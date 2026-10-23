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
//   <keyword> addalias 💪 swole    save "swole" for 💪
//   <keyword> removealias swole    remove it
//   <keyword> aliases              list them, plus the file, with remove-on-Enter
//
// The keyword is never written as a literal: it is Flow's, the user can rebind it, and every
// string here shows the one this installation actually answers to (`readActionKeyword`).
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
// Adding an alias starts from the emoji, and no Flow Launcher route can put that emoji in the
// command for the user: a context-menu action gets one API call, the menu overwrites the query text
// on the way out, and autocomplete's fallback (the row's Title) makes Ctrl+Tab a party trick that
// only works once. So the menu copies the finished command to the clipboard instead - see
// buildAddAliasResult, and docs/FRECENCY_AND_ALIASES.md for the measurements.

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

/**
 * The action that opens the aliases file, creating it first if this is the first time.
 *
 * It is our own action rather than a direct `Flow.Launcher.*` call because the file has to exist
 * before it can be opened, and that is a write - which only an action may do.
 *
 * `Flow.Launcher.ShellRun` is the wrong tool for this and was silently doing nothing:
 * `ShellRun(cmd, filename)` runs `filename` *as the program*, with `cmd` as its arguments, so
 * `ShellRun('', 'aliases.json')` asked Windows to execute a JSON file. `OpenAppUri` is the API
 * call that ends in `Process.Start(..., UseShellExecute = true)`, i.e. "open with the default
 * program", and it takes one string - which `ExecuteFlowLauncherAPI`'s exact-type lookup needs.
 */
const OPEN_ALIASES_ACTION: JsonRpcAction = { method: 'openaliases', parameters: [] };

/**
 * The menu entry that hands over the add-an-alias command.
 *
 * Flow Launcher cannot let a plugin start typing for the user, and every route that looks like it
 * fails for a reason that is now measured rather than assumed:
 *
 *   `ChangeQuery` from a menu item sets the text but does not leave the menu - `Query()` sees a
 *   context menu selected and re-filters the menu instead of querying. Leaving the menu needs a
 *   second call (`BackToQueryResults`), and one action gets exactly one `Flow.Launcher.*` method.
 *   Even the two-call order would not help: returning from the menu restores the pre-menu query
 *   text (`MainViewModel.SelectedResults` setter), so a command written inside the menu is
 *   overwritten on the way out.
 *
 *   `Result.AutoCompleteText` is honest but awkward: autocomplete is Ctrl+Tab, and it falls back
 *   to the row's Title on the next press ("Now type the name"), which reads as a glitch.
 *
 * So the entry copies the finished command instead. One API call, no hidden keystrokes, and what
 * the user pastes is exactly what they could have typed - the same teaching effect.
 *
 * @param emoji The emoji the selected result stands for.
 * @param actionKeyword The word that routes the query back to this plugin.
 */
export function buildAddAliasResult (emoji: string, actionKeyword: string): Result {
  return {
    Title: 'Add an alias for this emoji',
    Subtitle: 'Copies to your clipboard the ready-made command. Paste it and complete from there!',
    IcoPath: emojiIcon(emoji),
    // CopyToClipboard(text, directCopy, showDefaultNotification). The notification is the only
    // feedback there is: the menu closes with this click.
    JsonRPCAction: {
      method: 'Flow.Launcher.CopyToClipboard',
      parameters: [`${actionKeyword} addalias ${emoji} `, false, true]
    }
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
  paths: { settingsDirectory: string | null },
  actionKeyword: string
): Result[] | null {
  if (command.kind === 'none') {
    return null;
  }

  if (command.kind === 'add') {
    const alias = command.alias.trim().toLowerCase();

    return [{
      Title: `Save “${alias}” as an alias`,
      Subtitle: `Press Enter to confirm. Typing “${alias}” will then match this emoji.`,
      IcoPath: emojiIcon(command.emoji),
      JsonRPCAction: { method: 'addalias', parameters: [alias, command.emoji] }
    }];
  }

  if (command.kind === 'name-missing') {
    return [{
      Title: 'Now type the name',
      Subtitle: `${actionKeyword} addalias ${command.emoji} <name>`,
      IcoPath: emojiIcon(command.emoji)
    }];
  }

  if (command.kind === 'emoji-missing') {
    return [{
      Title: 'Type the emoji first, then the name',
      Subtitle: `${actionKeyword} addalias 💪 swole (search, press Enter to copy an emoji, paste it here)`,
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
      Subtitle: `${actionKeyword} removealias <name> - or ${actionKeyword} aliases to see them all`,
      IcoPath: 'img\\app.png'
    }];
  }

  return listingResults(paths, actionKeyword);
}

/**
 * Everything the user can look at: their aliases, and the one file behind them.
 *
 * Removing is Enter on a listed alias. That is blunt, so the title says what Enter does; the
 * settings page says where the file is for anyone who would rather edit it by hand.
 *
 * There is deliberately no entry for the emoji database. It ships with the plugin and is replaced
 * on every update, so hand-edits there are lost work - and pointing people at it produces bug
 * reports about disappearing aliases. The aliases file is the one that survives updates.
 */
function listingResults (paths: { settingsDirectory: string | null }, actionKeyword: string): Result[] {
  const aliases = paths.settingsDirectory === null ? {} : readAliases(paths.settingsDirectory);
  const results: Result[] = [
    {
      Title: 'Open my aliases file',
      Subtitle: paths.settingsDirectory === null
        ? 'Could not find the settings folder'
        : `${paths.settingsDirectory}\\${ALIASES_FILE_NAME}`,
      IcoPath: 'img\\app.png',
      ...(paths.settingsDirectory === null ? {} : { JsonRPCAction: OPEN_ALIASES_ACTION })
    }
  ];

  const entries = Object.entries(aliases).sort(([first], [second]) => first.localeCompare(second));

  if (entries.length === 0) {
    results.push({
      Title: 'No aliases yet',
      Subtitle: `Type: ${actionKeyword} addalias <emoji> <name>, for example ${actionKeyword} addalias 💪 swole`,
      IcoPath: 'img\\app.png'
    });

    return results;
  }

  for (const [alias, emoji] of entries) {
    results.push({
      Title: alias,
      Subtitle: 'Remove this alias',
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
  paths: { settingsDirectory: string | null },
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
      JsonRPCAction: OPEN_ALIASES_ACTION
    });
  }

  return menu;
}
