// src/actions/copy.ts
//
// Copies the selected emoji to the clipboard.
//
// `clipboardy` (and its `execa` dependency tree) costs ~30 ms to load, which is a third
// of a keystroke's budget. Flow Launcher runs a query on every keystroke but this file
// only on Enter, so the import is deferred until the moment it is actually needed.

import { FlowLauncher } from '../utils/flowLauncher.js';

export async function copy (text: string | undefined, displayNotification: boolean): Promise<void> {
  if (text === undefined) {
    return;
  }

  const { default: clipboard } = await import('clipboardy');

  clipboard.writeSync(text);

  if (displayNotification) {
    FlowLauncher.showMessage(text, 'Copied to clipboard!');
  }
}
