// tests/utils/flowLauncher.test.ts
//
// Flow Launcher reads a plugin's stdout with .NET's default decoding, which on Windows is the
// console code page - not UTF-8. Everything this plugin prints must therefore be pure ASCII,
// with the non-ASCII characters carried inside JSON escapes.

import { describe, expect, test } from 'vitest';
import { toAsciiEscapedJson } from '../../src/utils/flowLauncher.js';

describe('toAsciiEscapedJson', () => {
  test('writes the emoji as a JSON escape, so any code page decodes it', () => {
    const json = toAsciiEscapedJson({ Title: 'Add an alias for 💪' });

    expect(json).toBe('{"Title":"Add an alias for \\ud83d\\udcaa"}');
    // The bytes on the wire are ASCII; Flow's JSON parser restores the emoji.
    expect(json).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(json).Title).toBe('Add an alias for 💪');
  });

  test('escapes typographic quotes and accents too', () => {
    const json = toAsciiEscapedJson({ text: '“quoted” café' });

    expect(json).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(json).text).toBe('“quoted” café');
  });

  test('leaves plain ASCII untouched', () => {
    expect(toAsciiEscapedJson({ method: 'copy', parameters: ['🙈', true] }))
      .toBe('{"method":"copy","parameters":["\\ud83d\\ude48",true]}');
  });

  test('still produces one line', () => {
    expect(toAsciiEscapedJson({ Title: 'two\nlines' })).not.toContain('\n');
  });
});
