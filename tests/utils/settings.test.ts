// tests/utils/settings.test.ts

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_ACTION,
  DEFAULT_ENABLE_NOTIFICATION,
  DEFAULT_MAX_RESULTS,
  MAX_SELECTABLE_RESULTS,
  parseDefaultAction,
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

describe('parseDefaultAction', () => {
  test('reads the dropdown value Flow Launcher sends', () => {
    expect(parseDefaultAction('paste')).toBe('paste');
    expect(parseDefaultAction('copy')).toBe('copy');
  });

  test('reads the friendly wording the settings template now offers', () => {
    // SettingsTemplate.yaml is user-facing text and has already been reworded once. When the
    // options became "Copy Mode"/"Paste Mode", an exact match on 'paste' turned Paste Mode
    // into a silent Copy Mode - the setting looked right and did nothing.
    expect(parseDefaultAction('Paste Mode')).toBe('paste');
    expect(parseDefaultAction('Copy Mode')).toBe('copy');
    expect(parseDefaultAction('paste mode')).toBe('paste');
  });

  test('keeps copying when the setting is missing, as every earlier version did', () => {
    expect(parseDefaultAction(undefined)).toBe(DEFAULT_ACTION);
    expect(parseDefaultAction('')).toBe('copy');
  });

  test('ignores anything it does not recognise', () => {
    expect(parseDefaultAction('true')).toBe('copy');
    expect(parseDefaultAction('neither')).toBe('copy');
  });
});

describe('readSettings', () => {
  test('resolves the full settings object', () => {
    expect(readSettings({ enableNotification: false, maxResults: '10', defaultAction: 'paste' })).toEqual({
      maxResults: 10,
      enableNotification: false,
      defaultAction: 'paste'
    });
  });

  test('survives a missing settings object', () => {
    expect(readSettings(undefined)).toEqual({
      maxResults: DEFAULT_MAX_RESULTS,
      enableNotification: DEFAULT_ENABLE_NOTIFICATION,
      defaultAction: DEFAULT_ACTION
    });
  });

  test('only an explicit false disables notifications', () => {
    expect(readSettings({ enableNotification: true }).enableNotification).toBe(true);
    expect(readSettings({}).enableNotification).toBe(true);
    expect(readSettings({ enableNotification: false }).enableNotification).toBe(false);
  });
});
