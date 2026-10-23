// tests/actions/paste.test.ts
//
// paste() does three things: it asks Flow Launcher to fill the clipboard (by printing a
// Flow.Launcher request), it publishes a paste request for the resident agent, and - when no
// agent is running - it starts one. All three are mocked, so the test suite never writes
// outside the repository or starts anything.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { ensureAgentScript, requestPaste, sendJsonRpcRequest, startPasteAgent } = vi.hoisted(() => ({
  ensureAgentScript: vi.fn(),
  requestPaste: vi.fn(),
  sendJsonRpcRequest: vi.fn(),
  startPasteAgent: vi.fn()
}));

vi.mock('../../src/utils/pasteAgent.js', () => ({ ensureAgentScript, requestPaste, startPasteAgent }));
vi.mock('../../src/utils/flowLauncher.js', () => ({ sendJsonRpcRequest }));

const { paste } = await import('../../src/actions/paste.js');

beforeEach(() => {
  ensureAgentScript.mockReset();
  requestPaste.mockReset();
  requestPaste.mockReturnValue({ sequence: 1, agentRunning: true });
  sendJsonRpcRequest.mockReset();
  startPasteAgent.mockReset();
  startPasteAgent.mockReturnValue(true);
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

  test('leaves a running agent alone', () => {
    paste('🙈');

    expect(startPasteAgent).not.toHaveBeenCalled();
  });

  test('starts an agent when the request found none', () => {
    requestPaste.mockReturnValue({ sequence: 1, agentRunning: false });

    paste('🙈');

    // The request is already on disk, and the agent adopts requests younger than its startup
    // grace, so this is what turns "nothing happened" into a paste a moment later.
    expect(startPasteAgent).toHaveBeenCalledTimes(1);
  });

  test('publishes the request before it starts an agent', () => {
    const order: string[] = [];
    requestPaste.mockImplementation(() => {
      order.push('request');

      return { sequence: 1, agentRunning: false };
    });
    startPasteAgent.mockImplementation(() => order.push('start'));

    paste('🙈');

    expect(order).toEqual(['request', 'start']);
  });

  test('does nothing without an emoji', () => {
    paste(undefined);
    paste('');

    expect(sendJsonRpcRequest).not.toHaveBeenCalled();
    expect(requestPaste).not.toHaveBeenCalled();
  });
});
