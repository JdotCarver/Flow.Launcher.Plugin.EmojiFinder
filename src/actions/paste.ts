// src/actions/paste.ts
//
// Puts the chosen emoji at the user's cursor: copy it, then press Ctrl+V in the window
// the user came from.
//
// The copy itself is delegated to Flow Launcher (`Flow.Launcher.CopyToClipboard`), which
// runs in-process: unicode-safe, no extra node process, and it settles the clipboard
// before our helper starts typing. Our process only exists to start that helper and then
// get out of the way (see src/utils/pasteHelper.ts for why that matters).

import { sendJsonRpcRequest } from '../utils/flowLauncher.js';
import { spawnPasteHelper } from '../utils/pasteHelper.js';
import { trace } from '../utils/trace.js';

export async function paste (text: string | undefined): Promise<void> {
  if (text === undefined || text === '') {
    trace('paste:skipped', { reason: 'no emoji in the action parameters' });

    return;
  }

  // Flow reads this from our stdout after we exit and copies in-process. All three
  // arguments are required: Flow resolves the method by exact parameter types, and C#
  // optional parameters do not participate in that lookup.
  sendJsonRpcRequest({
    method: 'Flow.Launcher.CopyToClipboard',
    parameters: [text, false, false]
  });

  // Awaited: the helper must be running before this process disappears, otherwise Flow
  // takes it down mid-start-up and nothing is ever pasted. See src/utils/pasteHelper.ts.
  const outcome = await spawnPasteHelper(text);

  trace('paste:spawn', { emoji: text, ...outcome });
}
