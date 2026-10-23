// src/actions/paste.ts
//
// Puts the chosen emoji at the user's cursor: copy it, then tell the resident paste agent to
// press Ctrl+V in the window the user came from.
//
// The copy itself is delegated to Flow Launcher (`Flow.Launcher.CopyToClipboard`), which runs
// in-process: unicode-safe, no extra node process, and it settles the clipboard before the
// agent types. Nothing is started here - this process is destroyed by Flow the moment it
// returns, and anything it starts dies with it (see src/utils/pasteAgent.ts).

import { sendJsonRpcRequest } from '../utils/flowLauncher.js';
import { ensureAgentScript, requestPaste } from '../utils/pasteAgent.js';
import { trace } from '../utils/trace.js';

export function paste (text: string | undefined): void {
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

  // Keep the agent's script current with this build, then ask it to paste. Writing a small
  // file and returning is all this process has time for - and all it needs to do.
  ensureAgentScript();

  const outcome = requestPaste(text);

  trace('paste:request', { emoji: text, ...outcome });
}
