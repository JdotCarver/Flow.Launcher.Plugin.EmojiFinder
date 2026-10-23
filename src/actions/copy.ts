// src/actions/copy.ts
//
// Copies the selected emoji to the clipboard, and records the pick.
//
// Two ways to copy, chosen by whether the user wants a notification:
//
//   with a notification - `clipboardy` is imported (deferred: it and its `execa` dependency
//     tree cost ~30 ms to load, and Flow Launcher runs a query on every keystroke while this
//     file only runs on Enter), because the toast is the only way to say *which* emoji was
//     copied. Flow's own notification says "Copy text", which is less useful.
//
//   without one - the copy is handed to Flow Launcher (`Flow.Launcher.CopyToClipboard`), which
//     does it in-process on an STA thread with retries: no PowerShell, no clipboard race.
//
// The point of this file is now also the third line: every pick goes through here, so every
// pick can be counted. Flow Launcher's own selection count makes used emoji rise inside a
// query, but it cannot answer an empty query with emoji it was never sent - and it only ever
// sees the results we return.

import { FlowLauncher, sendJsonRpcRequest } from '../utils/flowLauncher.js';
import { recordUsage, resolvePluginSettingsDirectory } from '../utils/pluginData.js';

export async function copy (text: string | undefined, displayNotification: boolean): Promise<void> {
  if (text === undefined) {
    return;
  }

  recordPick(text);

  if (!displayNotification) {
    // Flow reads this from our stdout after we exit, exactly like the paste action's copy.
    sendJsonRpcRequest({ method: 'Flow.Launcher.CopyToClipboard', parameters: [text, false, false] });

    return;
  }

  const { default: clipboard } = await import('clipboardy');

  clipboard.writeSync(text);
  FlowLauncher.showMessage(text, 'Copied to clipboard!');
}

/**
 * Remembers that this emoji was picked, so an empty query can show it.
 *
 * Failure is silent and harmless by design: a read-only settings folder must not turn a copy
 * into an error.
 */
export function recordPick (emoji: string): void {
  try {
    const settingsDirectory = resolvePluginSettingsDirectory();

    if (settingsDirectory !== null) {
      recordUsage(settingsDirectory, emoji);
    }
  } catch {
    // Nothing was copied any worse because the history could not be written.
  }
}
