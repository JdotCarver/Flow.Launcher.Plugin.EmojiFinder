// tests/utils/pasteHelper.test.ts
//
// The helper is a PowerShell script we cannot execute here (no Windows, no PowerShell),
// so the tests check the two things that can actually be wrong on our side: the script
// we generate, and how it is encoded for -EncodedCommand.

import { describe, expect, test } from 'vitest';
import {
  buildPasteScript,
  encodePowerShellCommand
} from '../../src/utils/pasteHelper.js';

describe('buildPasteScript', () => {
  test('waits for Flow to hide before typing', () => {
    const script = buildPasteScript('🙈');

    expect(script).toContain('Get-Process -Name \'Flow.Launcher*\'');
    expect(script).toContain('MainWindowHandle');
    expect(script).toContain('-not $flowWindowIsVisible');
  });

  test('waits for the clipboard to hold the emoji before typing', () => {
    const script = buildPasteScript('🙈');

    expect(script).toContain('$clipboardHoldsEmoji');
    expect(script).toContain('[System.Windows.Forms.Clipboard]::GetText()');
  });

  test('sends Ctrl+V only when both conditions held', () => {
    const script = buildPasteScript('🙈');

    expect(script).toContain('if ($shouldPaste)');
    expect(script).toContain("[System.Windows.Forms.SendKeys]::SendWait('^v')");
  });

  test('gives up instead of typing into Flow when the conditions never hold', () => {
    const script = buildPasteScript('🙈');

    // $shouldPaste starts false and is only set inside the wait loop, so a timeout ends
    // the script without typing anything anywhere.
    expect(script).toContain('$shouldPaste = $false');
    expect(script.indexOf('$shouldPaste = $true')).toBeLessThan(
      script.indexOf('if ($shouldPaste)')
    );
  });

  test('embeds the emoji as a PowerShell string literal', () => {
    expect(buildPasteScript('🙈')).toContain("$targetEmoji = '🙈'");
  });

  test('escapes an apostrophe in the payload', () => {
    // Not an emoji, but the function must not produce a syntax error for anything.
    expect(buildPasteScript("o'clock")).toContain("$targetEmoji = 'o''clock'");
  });

  test('works for multi-codepoint emoji', () => {
    expect(buildPasteScript('👨‍👩‍👧‍👦')).toContain("$targetEmoji = '👨‍👩‍👧‍👦'");
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
