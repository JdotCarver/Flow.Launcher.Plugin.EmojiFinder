// tests/actions/copy.test.ts
//
// copy() touches the real clipboard, which a test machine does not have, and now also the
// usage history, which a test must not write outside its own folder. Both are mocked, so the
// test checks *what* would have been written and counted - not either.

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { writeSync, showMessage, sendJsonRpcRequest, recordUsage, resolvePluginSettingsDirectory } = vi.hoisted(() => ({
  writeSync: vi.fn(),
  showMessage: vi.fn(),
  sendJsonRpcRequest: vi.fn(),
  recordUsage: vi.fn(),
  resolvePluginSettingsDirectory: vi.fn()
}));

vi.mock('clipboardy', () => ({ default: { writeSync } }));
vi.mock('../../src/utils/flowLauncher.js', () => ({ FlowLauncher: { showMessage }, sendJsonRpcRequest }));
vi.mock('../../src/utils/pluginData.js', () => ({ recordUsage, resolvePluginSettingsDirectory }));

const { copy } = await import('../../src/actions/copy.js');

beforeEach(() => {
  writeSync.mockClear();
  showMessage.mockClear();
  sendJsonRpcRequest.mockClear();
  recordUsage.mockClear();
  resolvePluginSettingsDirectory.mockReset();
  resolvePluginSettingsDirectory.mockReturnValue('C:\\Flow\\Settings\\Plugins\\d50362aa29f04cd59032bb44a5d5f7e5');
});

describe('copy', () => {
  test('writes the emoji to the clipboard', async () => {
    await copy('🙈', true);

    expect(writeSync).toHaveBeenCalledWith('🙈');
  });

  test('notifies by default, naming the emoji', async () => {
    await copy('🙈', true);

    expect(showMessage).toHaveBeenCalledWith('🙈', 'Copied to clipboard!');
  });

  test('with notifications off, Flow does the copy in-process instead of PowerShell', async () => {
    await copy('🙈', false);

    expect(writeSync).not.toHaveBeenCalled();
    expect(showMessage).not.toHaveBeenCalled();
    expect(sendJsonRpcRequest).toHaveBeenCalledWith({
      method: 'Flow.Launcher.CopyToClipboard',
      parameters: ['🙈', false, false]
    });
  });

  test('the native copy always carries all three arguments', async () => {
    // Flow resolves Flow.Launcher.* by exact parameter types via reflection, and C# defaults
    // do not take part in that lookup: a two-argument call is silently dropped.
    await copy('🙈', false);

    const [request] = sendJsonRpcRequest.mock.calls[0] as [{ parameters: unknown[] }];

    expect(request.parameters).toHaveLength(3);
    expect(request.parameters[1]).toBe(false);
    expect(request.parameters[2]).toBe(false);
  });

  test('counts the pick, whichever way it copied', async () => {
    await copy('🙈', true);
    await copy('🚀', false);

    expect(recordUsage).toHaveBeenNthCalledWith(1, 'C:\\Flow\\Settings\\Plugins\\d50362aa29f04cd59032bb44a5d5f7e5', '🙈');
    expect(recordUsage).toHaveBeenNthCalledWith(2, 'C:\\Flow\\Settings\\Plugins\\d50362aa29f04cd59032bb44a5d5f7e5', '🚀');
  });

  test('still copies when the history cannot be written', async () => {
    recordUsage.mockImplementation(() => {
      throw new Error('read-only folder');
    });

    await copy('🙈', true);

    expect(writeSync).toHaveBeenCalledWith('🙈');
  });

  test('copies without counting when this is not a Flow Launcher layout', async () => {
    resolvePluginSettingsDirectory.mockReturnValue(null);

    await copy('🙈', true);

    expect(recordUsage).not.toHaveBeenCalled();
    expect(writeSync).toHaveBeenCalledWith('🙈');
  });

  test('does nothing when there is no emoji', async () => {
    await copy(undefined, true);

    expect(writeSync).not.toHaveBeenCalled();
    expect(showMessage).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
