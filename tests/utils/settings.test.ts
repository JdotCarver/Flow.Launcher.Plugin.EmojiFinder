// tests/utils/settings.test.ts

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_MAX_RESULTS,
  MAX_SELECTABLE_RESULTS,
  parseMaxResults,
  readSettings
} from '../../src/utils/settings.js';

describe('parseMaxResults', () => {
  test('reads the string Flow Launcher sends for a dropdown', () => {
    expect(parseMaxResults('25')).toBe(25);
    expect(parseMaxResults('250')).toBe(250);
  });

  test('accepts a number, for robustness', () => {
    expect(parseMaxResults(50)).toBe(50);
  });

  test('falls back to the default when the setting is missing', () => {
    expect(parseMaxResults(undefined)).toBe(DEFAULT_MAX_RESULTS);
    expect(parseMaxResults('')).toBe(DEFAULT_MAX_RESULTS);
  });

  test('falls back to the default on garbage instead of returning everything', () => {
    expect(parseMaxResults('all')).toBe(DEFAULT_MAX_RESULTS);
    expect(parseMaxResults('0')).toBe(DEFAULT_MAX_RESULTS);
    expect(parseMaxResults('-3')).toBe(DEFAULT_MAX_RESULTS);
    expect(parseMaxResults('NaN')).toBe(DEFAULT_MAX_RESULTS);
  });

  test('clamps a hand-edited settings file to the ceiling', () => {
    expect(parseMaxResults('100000')).toBe(MAX_SELECTABLE_RESULTS);
  });

  test('ignores a fractional value rather than returning a fractional count', () => {
    expect(parseMaxResults('25.9')).toBe(25);
  });
});

describe('readSettings', () => {
  test('resolves the full settings object', () => {
    expect(readSettings({ enableNotification: true, maxResults: '10' })).toEqual({ maxResults: 10 });
  });

  test('survives a missing settings object', () => {
    expect(readSettings(undefined)).toEqual({ maxResults: DEFAULT_MAX_RESULTS });
  });
});
