// tests/actions/query.test.ts
//
// The plugin talks to Flow Launcher by printing one JSON document on stdout, so the
// tests do the same thing Flow does: call query(), then parse what was printed.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { query } from '../../src/actions/query.js';
import type { Result } from '../../src/types.js';

const consoleMock = vi.spyOn(console, 'log').mockImplementation(() => undefined);

afterEach(() => {
  consoleMock.mockClear();
});

function queryAndReadPayload (
  input: string,
  settings: Record<string, unknown>
): { result: Result[] } {
  query(input, settings as never);

  const printed = consoleMock.mock.calls.at(-1)?.[0];

  return JSON.parse(String(printed));
}

describe('query', () => {
  test('returns at most the configured number of results', () => {
    const { result } = queryAndReadPayload('a', { enableNotification: true, maxResults: '10' });

    expect(result).toHaveLength(10);
  });

  test('falls back to the default when the setting is missing', () => {
    const { result } = queryAndReadPayload('a', { enableNotification: true });

    expect(result).toHaveLength(25);
  });

  test('returns everything on offer when the query is narrower than the limit', () => {
    const { result } = queryAndReadPayload('red heart', { enableNotification: true, maxResults: '25' });

    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(25);
  });

  test('sends no results for a query that matches nothing', () => {
    expect(queryAndReadPayload('zzzzzz', { enableNotification: true }).result).toEqual([]);
  });

  test('builds results Flow Launcher can render and act on', () => {
    const { result } = queryAndReadPayload('smile', {
      enableNotification: true,
      maxResults: '1'
    });

    expect(result[0]).toEqual({
      Title: expect.any(String),
      Subtitle: expect.any(String),
      JsonRPCAction: {
        method: 'copy',
        parameters: [expect.any(String), true]
      },
      IcoPath: expect.stringMatching(/^icons\\[0-9a-f-]+\.png$/)
    });
  });

  test('carries the notification setting into the action parameters', () => {
    const { result } = queryAndReadPayload('smile', {
      enableNotification: false,
      maxResults: '1'
    });

    expect(result[0]?.JsonRPCAction?.parameters[1]).toBe(false);
  });

  test('shows the emoji name as the title and its keywords as the subtitle', () => {
    const { result } = queryAndReadPayload('grinning face', { enableNotification: true, maxResults: '50' });
    const grinningFace = result.find(entry => entry.Title === 'Grinning Face');

    expect(grinningFace?.Subtitle).toBe('Face, Smile, Happy, Joy, :D, Grin, Smiley');
  });
});
