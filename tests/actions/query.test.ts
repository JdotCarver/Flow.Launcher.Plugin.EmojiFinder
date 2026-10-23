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
      IcoPath: expect.stringMatching(/^icons\\[0-9a-f-]+\.png$/),
      Score: expect.any(Number),
      RecordKey: expect.any(String)
    });
  });

  test('sends the score and the record key Flow needs to rank by use', () => {
    const { result } = queryAndReadPayload('smile', { enableNotification: true, maxResults: '2' });

    // Score is our relevance order; Flow adds the user's selection count to it.
    expect(result[0]?.Score).toBeGreaterThan(0);
    expect(result[0]?.Score).toBeGreaterThanOrEqual(result[1]?.Score ?? 0);
    // The emoji is the stable identity, so a changed subtitle cannot lose a history entry.
    expect(result[0]?.RecordKey).toMatch(/\p{Extended_Pictographic}/u);
  });

  describe('choosing the copy action', () => {
    test('with notifications on, our own action is used so the emoji can be named', () => {
      const { result } = queryAndReadPayload('smile', {
        enableNotification: true,
        maxResults: '1'
      });

      expect(result[0]?.JsonRPCAction).toEqual({
        method: 'copy',
        parameters: [expect.any(String), true]
      });
    });

    test('with notifications off, Flow copies the emoji itself and no process starts', () => {
      const { result } = queryAndReadPayload('smile', {
        enableNotification: false,
        maxResults: '1'
      });

      expect(result[0]?.JsonRPCAction).toEqual({
        method: 'Flow.Launcher.CopyToClipboard',
        parameters: [expect.any(String), false, false]
      });
    });

    test('the native action always carries all three arguments', () => {
      // Flow resolves Flow.Launcher.* by exact parameter types via reflection, and C#
      // defaults do not take part in that lookup: a two-argument call is silently
      // dropped. This test exists so nobody "simplifies" the call.
      const { result } = queryAndReadPayload('smile', { enableNotification: false });
      const parameters = result[0]?.JsonRPCAction?.parameters ?? [];

      expect(parameters).toHaveLength(3);
      expect(parameters[0]).toEqual(expect.any(String));
      expect(parameters[1]).toBe(false);
      expect(parameters[2]).toBe(false);
    });

    test('treats a missing notification setting as enabled, like Flow does', () => {
      const { result } = queryAndReadPayload('smile', { maxResults: '1' });

      expect(result[0]?.JsonRPCAction?.method).toBe('copy');
    });
  });

  describe('paste at cursor', () => {
    test('uses our own action, which starts the paste helper', () => {
      const { result } = queryAndReadPayload('smile', {
        maxResults: '1',
        defaultAction: 'paste'
      });

      expect(result[0]?.JsonRPCAction).toEqual({
        method: 'paste',
        parameters: [expect.any(String)]
      });
    });

    test('takes precedence over the notification setting', () => {
      for (const enableNotification of [true, false]) {
        const { result } = queryAndReadPayload('smile', {
          maxResults: '1',
          defaultAction: 'paste',
          enableNotification
        });

        expect(result[0]?.JsonRPCAction?.method).toBe('paste');
      }
    });

    test('still copies when the setting says so', () => {
      const { result } = queryAndReadPayload('smile', {
        maxResults: '1',
        defaultAction: 'copy',
        enableNotification: false
      });

      expect(result[0]?.JsonRPCAction?.method).toBe('Flow.Launcher.CopyToClipboard');
    });
  });

  test('shows the emoji name as the title and its keywords as the subtitle', () => {
    const { result } = queryAndReadPayload('grinning face', { enableNotification: true, maxResults: '50' });
    const grinningFace = result.find(entry => entry.Title === 'Grinning Face');

    expect(grinningFace?.Subtitle).toBe('Face, Smile, Happy, Joy, :D, Grin, Smiley');
  });
});
