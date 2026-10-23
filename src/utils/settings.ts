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
 * Whether to show a notification after copying, when the user has not chosen otherwise.
 * Matches SettingsTemplate.yaml, which offers it checked (upstream behaviour).
 */
export const DEFAULT_ENABLE_NOTIFICATION = true;

/** What picking a result does. */
export type DefaultAction = 'copy' | 'paste';

/** What picking a result does when the user has not chosen otherwise. */
export const DEFAULT_ACTION: DefaultAction = 'copy';

export type ResolvedSettings = {
  maxResults: number
  enableNotification: boolean
  defaultAction: DefaultAction
};

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
 * Resolves what picking a result should do.
 *
 * Only the exact value "paste" switches modes; anything else (missing setting, an old
 * Settings.json, a hand-edited value) keeps copying, which is what every version before
 * this one did.
 */
export function parseDefaultAction (value: string | undefined): DefaultAction {
  return value === 'paste' ? 'paste' : DEFAULT_ACTION;
}

/**
 * Resolves every setting the query path needs, in one place.
 */
export function readSettings (settings: Settings | undefined): ResolvedSettings {
  return {
    maxResults: parseMaxResults(settings?.maxResults),
    enableNotification: settings?.enableNotification !== false,
    defaultAction: parseDefaultAction(settings?.defaultAction)
  };
}
