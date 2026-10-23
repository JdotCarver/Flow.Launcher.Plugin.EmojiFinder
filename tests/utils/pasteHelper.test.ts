// tests/utils/pasteHelper.test.ts
//
// The helper is a PowerShell script we cannot execute here (no Windows, no PowerShell),
// so these tests check the two things that can actually be wrong on our side: the script
// we generate, and how it is encoded and spawned.

import { describe, expect, test } from 'vitest';
import {
  buildPasteScript,
  buildPasteSpawnOptions,
  encodePowerShellCommand,
  spawnPasteHelper
} from '../../src/utils/pasteHelper.js';

describe('buildPasteScript', () => {
  test('waits for Flow to hide before typing', () => {
    const script = buildPasteScript('🙈');

    expect(script).toContain('Get-Process -Name \'Flow.Launcher*\'');
    expect(script).toContain('MainWindowHandle');
    expect(script).toContain('-not $flowVisible');
  });

  test('accepts either "no visible window" or "focus moved elsewhere"', () => {
    const script = buildPasteScript('🙈');

    // The second signal exists because a minimised Flow keeps MainWindowHandle non-zero.
    expect(script).toContain('$flowHasFocus');
    expect(script).toContain('AutomationElement]::FocusedElement');
    expect(script).toContain('(-not $flowVisible -or -not $flowHasFocus)');
  });

  test('waits for the clipboard to hold the emoji before typing', () => {
    const script = buildPasteScript('🙈');

    expect(script).toContain('$clipboardMatches');
    expect(script).toContain('[System.Windows.Forms.Clipboard]::GetText()');
  });

  test('ignores variation selectors and joiners when comparing', () => {
    // Some clipboard producers drop U+FE0F, which would otherwise make the loop wait
    // forever for an emoji that is already there.
    const script = buildPasteScript('❤️');

    expect(script).toContain('-replace \'[\\uFE0E\\uFE0F\\u200D]\'');
  });

  test('sends Ctrl+V only when both conditions held', () => {
    const script = buildPasteScript('🙈');

    expect(script).toContain('if ($shouldPaste)');
    expect(script).toContain("[System.Windows.Forms.SendKeys]::SendWait('^v')");
  });

  test('gives up instead of typing into Flow when the conditions never hold', () => {
    const script = buildPasteScript('🙈');

    expect(script).toContain('$shouldPaste = $false');
    expect(script.indexOf('$shouldPaste = $true')).toBeLessThan(
      script.indexOf('if ($shouldPaste)')
    );
  });

  test('embeds the emoji as a PowerShell string literal', () => {
    expect(buildPasteScript('🙈')).toContain("$targetEmoji = '🙈'");
  });

  test('escapes an apostrophe in the payload', () => {
    expect(buildPasteScript("o'clock")).toContain("$targetEmoji = 'o''clock'");
  });

  test('works for multi-codepoint emoji', () => {
    expect(buildPasteScript('👨‍👩‍👧‍👦')).toContain("$targetEmoji = '👨‍👩‍👧‍👦'");
  });

  describe('tracing', () => {
    test('stays silent when no log path is given', () => {
      const script = buildPasteScript('🙈');

      expect(script).toContain("$logPath = ''");
      expect(script).toContain('[string]::IsNullOrEmpty($logPath)');
    });

    test('writes to the path it is given, escaped for PowerShell', () => {
      const script = buildPasteScript('🙈', "C:\\Users\\o'brien\\dogfood\\runtime.log");

      expect(script).toContain("$logPath = 'C:\\Users\\o''brien\\dogfood\\runtime.log'");
    });

    test('creates its own log folder, because it can beat the plugin to it', () => {
      const script = buildPasteScript('🙈', 'C:\\plugins\\emoji\\dogfood\\runtime.log');

      expect(script).toContain('New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath)');
    });

    test('narrates every decision point, so a failure can be read from the log', () => {
      const script = buildPasteScript('🙈', 'C:\\log.txt');

      for (const marker of ['start pid=', 'winforms-error', 'uiautomation-error', 'poll ', 'decision paste=', 'sendkeys sent', 'exit']) {
        expect(script).toContain(marker);
      }
    });
  });
});

describe('encodePowerShellCommand', () => {
  test('produces base64 of UTF-16LE, which is what powershell -EncodedCommand expects', () => {
    const encoded = encodePowerShellCommand("Write-Output 'é'");

    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe("Write-Output 'é'");
  });

  test('round-trips emoji unharmed', () => {
    const script = buildPasteScript('❤️');
    const decoded = Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le');

    expect(decoded).toContain("$targetEmoji = '❤️'");
    expect(decoded).toBe(script);
  });
});

describe('buildPasteSpawnOptions', () => {
  test('never asks for a detached process', () => {
    // Regression: `detached: true` becomes DETACHED_PROCESS on Windows, gives PowerShell
    // no console, and it then starts, exits 0 and runs none of the script. Measured on
    // the Windows runner - every detached variant wrote zero trace lines, the attached
    // one wrote six. The helper outlives us through `child.unref()` instead.
    expect(buildPasteSpawnOptions(null)).not.toHaveProperty('detached');
  });

  test('hides the window, because a flashing console would defeat the whole feature', () => {
    expect(buildPasteSpawnOptions(null).windowsHide).toBe(true);
  });

  test('discards output, and sends stderr to the log file when tracing is on', () => {
    expect(buildPasteSpawnOptions(null).stdio).toEqual(['ignore', 'ignore', 'ignore']);
    expect(buildPasteSpawnOptions(3).stdio).toEqual(['ignore', 'ignore', 3]);
  });
});

describe('spawnPasteHelper', () => {
  test('refuses to pretend on platforms without PowerShell', () => {
    // The test suite runs on Linux, so this result is deterministic here and proves the
    // guard exists. On Windows the same call would start the helper instead.
    const outcome = spawnPasteHelper('🙈');

    if (process.platform === 'win32') {
      expect(outcome.started).toBe(true);
    } else {
      expect(outcome).toEqual({
        started: false,
        reason: expect.stringContaining('Windows-only')
      });
    }
  });
});
