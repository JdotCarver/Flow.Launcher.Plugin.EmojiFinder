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
import { find } from '../utils/find.js';
import { sendJsonRpcRequest } from '../utils/flowLauncher.js';
import { readSettings } from '../utils/settings.js';
import { getIconFileName } from '../utils/utils.js';

/**
 * Builds the action Flow runs when the user picks a result.
 *
 * Paste mode is the only case that needs our own process (to see whether the paste agent is
 * running), and it gets its clipboard content from Flow in the same breath.
 *
 * Copy mode:
 *   - notifications off -> Flow copies in-process; picking a result starts no process
 *     at all, which is the fastest path available;
 *   - notifications on  -> our own action, because it is the only way to show a
 *     notification that names the emoji. Costs one short-lived process (see
 *     docs/PERF_ANALYSIS.md).
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

  if (enableNotification) {
    return { method: 'copy', parameters: [emoji, true] };
  }

  return { method: 'Flow.Launcher.CopyToClipboard', parameters: [emoji, false, false] };
}

/**
 * @param input What the user typed after the action keyword.
 * @param settings Plugin settings as sent by Flow Launcher.
 */
export function query (input: string | undefined, settings: Settings): void {
  const resolvedSettings = readSettings(settings);

  const request: Result[] = find(input ?? '', resolvedSettings.maxResults).map(finding => ({
    Title: finding.title,
    Subtitle: finding.subtitle,
    JsonRPCAction: buildResultAction(finding.emoji, resolvedSettings),
    IcoPath: getIconFileName(finding.emoji) ?? 'img\\app.png',
    // Our own relevance order, which Flow cannot reconstruct. Flow adds the user's selection
    // count to this, which is the "used emoji float up" behaviour, for free.
    Score: finding.score,
    RecordKey: finding.emoji
  }));

  sendJsonRpcRequest({ result: request });
}
