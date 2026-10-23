// src/actions/query.ts
//
// Answers a Flow Launcher query: turn what the user typed into the result list.
//
// Flow spawns this plugin once per keystroke, so this function is the hot path of the
// whole plugin. Two rules follow from that:
//   1. never hand Flow more results than a human can look at (see settings.ts);
//   2. build the payload in one pass, without per-result allocations we do not need.

import type { JsonRpcAction, Result, Settings } from '../types.js';
import { find } from '../utils/find.js';
import { sendJsonRpcRequest } from '../utils/flowLauncher.js';
import { readSettings } from '../utils/settings.js';
import { getIconFileName } from '../utils/utils.js';

/**
 * Builds the action Flow runs when the user picks a result.
 *
 * With notifications off, the copy is delegated to Flow itself: it executes any
 * `Flow.Launcher.*` action in-process, so picking an emoji starts no process at all.
 * With notifications on, we keep our own action because it is the only way to show a
 * notification that names the emoji; that costs one short-lived process (see
 * docs/PERF_ANALYSIS.md).
 *
 * Flow resolves `Flow.Launcher.*` methods by exact parameter types
 * (`IPublicAPI.GetMethod`), and optional C# parameters do not participate in that
 * lookup, so every argument must be sent: CopyToClipboard(text, directCopy,
 * showDefaultNotification).
 */
function buildCopyAction (emoji: string, enableNotification: boolean): JsonRpcAction {
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
  const { maxResults, enableNotification } = readSettings(settings);

  const request: Result[] = find(input ?? '', maxResults).map(finding => ({
    Title: finding.title,
    Subtitle: finding.subtitle,
    JsonRPCAction: buildCopyAction(finding.emoji, enableNotification),
    IcoPath: getIconFileName(finding.emoji) ?? 'img\\app.png'
  }));

  sendJsonRpcRequest({ result: request });
}
