// src/actions/query.ts
//
// Answers a Flow Launcher query: turn what the user typed into the result list.
//
// Flow spawns this plugin once per keystroke, so this function is the hot path of the
// whole plugin. Two rules follow from that:
//   1. never hand Flow more results than a human can look at (see settings.ts);
//   2. build the payload in one pass, without per-result allocations we do not need.

import type { ResolvedSettings } from '../utils/settings.js';
import type { JsonRpcAction, Result, Settings } from '../types.js';
import { buildAliasCommandResults, parseAliasCommand } from './aliases.js';
import { find } from '../utils/find.js';
import { sendJsonRpcRequest } from '../utils/flowLauncher.js';
import { migrateEnterModeSetting, readAliases, readUsage, resolvePluginSettingsDirectory } from '../utils/pluginData.js';
import { readSettings } from '../utils/settings.js';
import { getIconFileName } from '../utils/utils.js';

/**
 * Builds the action Flow runs when the user picks a result.
 *
 * Paste mode is the only case that needs our own process (to see whether the paste agent is
 * running), and it gets its clipboard content from Flow in the same breath.
 *
 * Copy mode always runs our own action, which costs one short-lived process. That is the price
 * of an empty query that knows what the user actually picks: Flow Launcher only ever sees the
 * results we return, so a pick Flow handles on its own is a pick we never learn about.
 * Inside that process, notifications off still means Flow does the copy in-process.
 *
 * Flow resolves `Flow.Launcher.*` methods by exact parameter types
 * (`IPublicAPI.GetMethod`), and optional C# parameters do not participate in that
 * lookup, so every argument must be sent: CopyToClipboard(text, directCopy,
 * showDefaultNotification).
 */
export function buildResultAction (
  emoji: string,
  { defaultAction, enableNotification }: Pick<ResolvedSettings, 'defaultAction' | 'enableNotification'>
): JsonRpcAction {
  if (defaultAction === 'paste') {
    return { method: 'paste', parameters: [emoji] };
  }

  return { method: 'copy', parameters: [emoji, enableNotification] };
}

/**
 * @param input What the user typed after the action keyword.
 * @param settings Plugin settings as sent by Flow Launcher.
 */
export function query (input: string | undefined, settings: Settings): void {
  const resolvedSettings = readSettings(settings);
  const search = input ?? '';
  const settingsDirectory = resolvePluginSettingsDirectory();

  // A legacy dropdown value makes Flow show an empty box. This is a read plus, only when the
  // value is legacy, one small write; the common case costs a single property test.
  if (settings.defaultAction !== undefined && settings.defaultAction !== 'Copy Mode' && settings.defaultAction !== 'Paste Mode') {
    migrateEnterModeSetting(settingsDirectory);
  }
  const aliasResults = buildAliasCommandResults(parseAliasCommand(search), { settingsDirectory });

  if (aliasResults !== null) {
    sendJsonRpcRequest({ result: aliasResults });

    return;
  }

  const request: Result[] = find(search, resolvedSettings.maxResults, {
    aliases: settingsDirectory === null ? undefined : readAliases(settingsDirectory),
    // Only an empty query is ranked by history, so only an empty query pays for reading it.
    usage: settingsDirectory === null || search.trim() !== '' ? undefined : readUsage(settingsDirectory)
  }).map(finding => ({
    Title: finding.title,
    Subtitle: finding.subtitle,
    JsonRPCAction: buildResultAction(finding.emoji, resolvedSettings),
    IcoPath: getIconFileName(finding.emoji) ?? 'img\\app.png',
    // Our own relevance order, which Flow cannot reconstruct. Flow adds the user's selection
    // count to this, which is the "used emoji float up" behaviour, for free.
    Score: finding.score,
    RecordKey: finding.emoji,
    // What the right-arrow menu receives when the user opens it on this result.
    ContextData: finding.emoji
  }));

  sendJsonRpcRequest({ result: request });
}
