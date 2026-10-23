// tests/actions/copy.test.ts
//
// copy() is the only place that touches the real clipboard, which a test machine does
// not have. Both the clipboard module and the Flow Launcher channel are mocked so the
// test can check *what* would have been written, not write it.

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { writeSync, showMessage } = vi.hoisted(() => ({
  writeSync: vi.fn(),
  showMessage: vi.fn()
}));

vi.mock('clipboardy', () => ({ default: { writeSync } }));
vi.mock('../../src/utils/flowLauncher.js', () => ({ FlowLauncher: { showMessage } }));

const { copy } = await import('../../src/actions/copy.js');

beforeEach(() => {
  writeSync.mockClear();
  showMessage.mockClear();
});

describe('copy', () => {
  test('writes the emoji to the clipboard', async () => {
    await copy('🙈', true);

    expect(writeSync).toHaveBeenCalledWith('🙈');
  });

  test('notifies by default', async () => {
    await copy('🙈', true);

    expect(showMessage).toHaveBeenCalledWith('🙈', 'Copied to clipboard!');
  });

  test('stays silent when notifications are disabled', async () => {
    await copy('🙈', false);

    expect(writeSync).toHaveBeenCalledOnce();
    expect(showMessage).not.toHaveBeenCalled();
  });

  test('does nothing when there is no emoji', async () => {
    await copy(undefined, true);

    expect(writeSync).not.toHaveBeenCalled();
    expect(showMessage).not.toHaveBeenCalled();
  });
});
