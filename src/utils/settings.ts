// src/utils/settings.ts
//
// Reads the plugin settings that arrive from Flow Launcher with every query.
//
// Flow serialises SettingsTemplate.yaml values into the `settings` object of the
// JSON-RPC payload. Dropdown and text values arrive as strings, checkboxes as
// booleans, and a value the user never touched may be missing entirely (older
// Settings.json files predate the setting). Everything here is defensive on purpose:
// a bad value must degrade to the default, never to "show every emoji".

import type { Settings } from '../types.js';

/** Number of emoji returned when the user has not chosen otherwise. */
export const DEFAULT_MAX_RESULTS = 25;

/** Highest value offered in SettingsTemplate.yaml, used as a sanity ceiling. */
export const MAX_SELECTABLE_RESULTS = 250;

/**
 * Resolves how many results the plugin may return.
 *
 * @param value Raw value from the settings object, or undefined when absent.
 * @returns A usable limit between 1 and MAX_SELECTABLE_RESULTS.
 */
export function parseMaxResults (value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_RESULTS;
  }

  return Math.min(Math.trunc(parsed), MAX_SELECTABLE_RESULTS);
}

/**
 * Resolves every setting the query path needs, in one place.
 */
export function readSettings (settings: Settings | undefined): { maxResults: number } {
  return {
    maxResults: parseMaxResults(settings?.maxResults)
  };
}
