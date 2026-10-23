// tests/actions/paste.test.ts
//
// paste() does two things: it asks Flow Launcher to fill the clipboard (by printing a
// Flow.Launcher request) and it starts the helper that presses Ctrl+V. The helper is
// mocked, so nothing is ever spawned by the test suite.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { spawnPasteHelper, sendJsonRpcRequest } = vi.hoisted(() => ({
  spawnPasteHelper: vi.fn(),
  sendJsonRpcRequest: vi.fn()
}));

vi.mock('../../src/utils/pasteHelper.js', () => ({ spawnPasteHelper }));
vi.mock('../../src/utils/flowLauncher.js', () => ({ sendJsonRpcRequest }));

const { paste } = await import('../../src/actions/paste.js');

beforeEach(() => {
  spawnPasteHelper.mockReset();
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

  test('starts the paste helper with the same emoji', () => {
    paste('🙈');

    expect(spawnPasteHelper).toHaveBeenCalledWith('🙈');
  });

  test('requests the copy before starting the helper', () => {
    const order: string[] = [];
    sendJsonRpcRequest.mockImplementation(() => order.push('copy'));
    spawnPasteHelper.mockImplementation(() => order.push('helper'));

    paste('🙈');

    expect(order).toEqual(['copy', 'helper']);
  });

  test('does nothing without an emoji', () => {
    paste(undefined);
    paste('');

    expect(sendJsonRpcRequest).not.toHaveBeenCalled();
    expect(spawnPasteHelper).not.toHaveBeenCalled();
  });
});
