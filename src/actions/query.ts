// src/actions/query.ts
//
// Answers a Flow Launcher query: turn what the user typed into the result list.
//
// Flow spawns this plugin once per keystroke, so this function is the hot path of the
// whole plugin. Two rules follow from that:
//   1. never hand Flow more results than a human can look at (see settings.ts);
//   2. build the payload in one pass, without per-result allocations we do not need.

import type { Result, Settings } from '../types.js';
import { find } from '../utils/find.js';
import { sendJsonRpcRequest } from '../utils/flowLauncher.js';
import { readSettings } from '../utils/settings.js';
import { getIconFileName } from '../utils/utils.js';

export function query (input: string | undefined, settings: Settings): void {
  const { maxResults } = readSettings(settings);

  const request: Result[] = find(input ?? '', maxResults).map(finding => ({
    Title: finding.title,
    Subtitle: finding.subtitle,
    JsonRPCAction: {
      method: 'copy',
      parameters: [finding.emoji, settings.enableNotification]
    },
    IcoPath: getIconFileName(finding.emoji) ?? 'img\\app.png'
  }));

  sendJsonRpcRequest({ result: request });
}
