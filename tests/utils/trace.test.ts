// tests/utils/trace.test.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { appendTraceLine, isTracingEnabled } from '../../src/utils/trace.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory (): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'emoji-finder-trace-'));
  temporaryDirectories.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('appendTraceLine', () => {
  test('writes one JSON object per line, so the file can be parsed later', () => {
    const file = path.join(temporaryDirectory(), 'runtime.log');

    appendTraceLine(file, 'paste:spawn', { emoji: '🙈', started: true });
    appendTraceLine(file, 'sendkeys', { ok: true });

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      at: expect.any(String),
      event: 'paste:spawn',
      emoji: '🙈',
      started: true
    });
    expect(JSON.parse(lines[1]).event).toBe('sendkeys');
  });

  test('creates the directory it is asked to write into', () => {
    const file = path.join(temporaryDirectory(), 'dogfood', 'nested', 'runtime.log');

    appendTraceLine(file, 'first');

    expect(fs.existsSync(file)).toBe(true);
  });

  test('appends instead of overwriting', () => {
    const file = path.join(temporaryDirectory(), 'runtime.log');

    appendTraceLine(file, 'one');
    appendTraceLine(file, 'two');

    expect(fs.readFileSync(file, 'utf8')).toContain('one');
    expect(fs.readFileSync(file, 'utf8')).toContain('two');
  });

  test('truncates a file that grew past the cap instead of growing forever', () => {
    const file = path.join(temporaryDirectory(), 'runtime.log');
    fs.writeFileSync(file, 'x'.repeat(300 * 1024));

    appendTraceLine(file, 'after-truncate');

    const content = fs.readFileSync(file, 'utf8');
    expect(content.length).toBeLessThan(1024);
    expect(content).toContain('after-truncate');
  });

  test('never throws, because tracing must not be able to break a copy', () => {
    const directory = temporaryDirectory();
    // A directory where a file is expected: writing must fail, quietly.
    const unusablePath = path.join(directory, 'as-a-directory');
    fs.mkdirSync(unusablePath);

    expect(() => appendTraceLine(unusablePath, 'nope')).not.toThrow();
  });
});

describe('isTracingEnabled', () => {
  test('is off unless the marker file exists', () => {
    const pluginRoot = temporaryDirectory();

    expect(isTracingEnabled(pluginRoot)).toBe(false);

    fs.writeFileSync(path.join(pluginRoot, 'trace.on'), '');

    expect(isTracingEnabled(pluginRoot)).toBe(true);
  });

  test('is off when the directory does not exist at all', () => {
    expect(isTracingEnabled(path.join(temporaryDirectory(), 'missing'))).toBe(false);
  });
});
