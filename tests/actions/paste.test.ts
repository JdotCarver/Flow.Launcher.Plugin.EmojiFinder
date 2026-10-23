// tests/actions/paste.test.ts
//
// paste() does two things: it asks Flow Launcher to fill the clipboard (by printing a
// Flow.Launcher request) and it publishes a paste request for the resident agent. Both are
// mocked, so the test suite never writes outside the repository or starts anything.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { ensureAgentScript, requestPaste, sendJsonRpcRequest } = vi.hoisted(() => ({
  ensureAgentScript: vi.fn(),
  requestPaste: vi.fn(),
  sendJsonRpcRequest: vi.fn()
}));

vi.mock('../../src/utils/pasteAgent.js', () => ({ ensureAgentScript, requestPaste }));
vi.mock('../../src/utils/flowLauncher.js', () => ({ sendJsonRpcRequest }));

const { paste } = await import('../../src/actions/paste.js');

beforeEach(() => {
  ensureAgentScript.mockReset();
  requestPaste.mockReset();
  requestPaste.mockReturnValue({ sequence: 1, agentRunning: true });
  sendJsonRpcRequest.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('paste', () => {
  test('asks Flow to copy the emoji, in-process, with every argument', () => {
    paste('🙈');

    // Two arguments would be silently dropped: Flow resolves Flow.Launcher.* by exact
    // parameter types and C# defaults are invisible to that lookup.
    expect(sendJsonRpcRequest).toHaveBeenCalledWith({
      method: 'Flow.Launcher.CopyToClipboard',
      parameters: ['🙈', false, false]
    });
  });

  test('publishes a paste request for the same emoji', () => {
    paste('🙈');

    expect(requestPaste).toHaveBeenCalledWith('🙈');
  });

  test('requests the copy before the paste request', () => {
    const order: string[] = [];
    sendJsonRpcRequest.mockImplementation(() => order.push('copy'));
    requestPaste.mockImplementation(() => {
      order.push('request');

      return { sequence: 1, agentRunning: true };
    });

    paste('🙈');

    expect(order).toEqual(['copy', 'request']);
  });

  test('starts nothing: the agent is already running, or it is not, and this process dies either way', () => {
    paste('🙈');

    // Regression guard for the design we abandoned. A process started here is killed with
    // this one when Flow releases it, which is exactly why paste never worked.
    expect(ensureAgentScript).toHaveBeenCalledTimes(1);
  });

  test('does nothing without an emoji', () => {
    paste(undefined);
    paste('');

    expect(sendJsonRpcRequest).not.toHaveBeenCalled();
    expect(requestPaste).not.toHaveBeenCalled();
  });
});
