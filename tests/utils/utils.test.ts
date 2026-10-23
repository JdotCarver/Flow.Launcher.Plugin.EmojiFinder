// tests/utils/utils.test.ts

import { describe, expect, test } from 'vitest';
import { getIconFileName } from '../../src/utils/utils.js';

describe('getIconFileName', () => {
  test('returns the appropriate icon file name for simple emoji', () => {
    expect(getIconFileName('🙈')).toBe('icons\\1f648.png');
  });

  test('returns the appropriate icon file name for composed emojis', () => {
    expect(getIconFileName('👨‍👩‍👧‍👦')).toBe('icons\\1f468-200d-1f469-200d-1f467-200d-1f466.png');
    expect(getIconFileName('👩‍💻')).toBe('icons\\1f469-200d-1f4bb.png');
  });

  test('only returns a lowercase file name, matching the files shipped in icons/', () => {
    expect(getIconFileName('😀')).toBe('icons\\1f600.png');
  });
});
