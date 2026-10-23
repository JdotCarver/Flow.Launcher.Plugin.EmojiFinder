// tests/tools/packagePaths.test.ts
//
// Packaging once shipped a plugin with no node_modules at all, because `npm ls
// --parseable` printed Windows paths that the old `path.sep`-based check could not match.
// These tests pin the parsing against both separator styles, so that failure cannot come
// back unnoticed from a Linux sandbox.

import { describe, expect, test } from 'vitest';
import { dependencyRelativePath, dependencyRelativePaths } from '../../tools/package-paths.mjs';

describe('dependencyRelativePath', () => {
  test('reads a POSIX path', () => {
    expect(dependencyRelativePath('/repo/node_modules/emojilib')).toBe('emojilib');
  });

  test('reads a Windows path with backslashes', () => {
    expect(dependencyRelativePath('C:\\repo\\node_modules\\emojilib')).toBe('emojilib');
  });

  test('reads a Windows path npm normalised to forward slashes', () => {
    expect(dependencyRelativePath('C:/repo/node_modules/emojilib')).toBe('emojilib');
  });

  test('keeps a nested dependency under its parent', () => {
    expect(dependencyRelativePath('/repo/node_modules/a/node_modules/b')).toBe('a/node_modules/b');
  });

  test('keeps a scoped package name intact', () => {
    expect(dependencyRelativePath('/repo/node_modules/@napi-rs/keyring')).toBe('@napi-rs/keyring');
  });

  test('ignores anything that is not a package', () => {
    expect(dependencyRelativePath('/repo')).toBeNull();
    expect(dependencyRelativePath('')).toBeNull();
    expect(dependencyRelativePath('/repo/node_modules/')).toBeNull();
    expect(dependencyRelativePath('/repo/src/utils/find.ts')).toBeNull();
  });
});

describe('dependencyRelativePaths', () => {
  test('collects every package once, in printed order', () => {
    const listing = [
      '/repo',
      '/repo/node_modules/clipboardy',
      '/repo/node_modules/emojilib',
      '/repo/node_modules/clipboardy',
      '/repo/node_modules/clipboardy/node_modules/execa'
    ].join('\n');

    expect(dependencyRelativePaths(listing)).toEqual([
      'clipboardy',
      'emojilib',
      'clipboardy/node_modules/execa'
    ]);
  });

  test('returns nothing for empty output, which the caller treats as fatal', () => {
    expect(dependencyRelativePaths('')).toEqual([]);
    expect(dependencyRelativePaths('\n\n')).toEqual([]);
  });
});
