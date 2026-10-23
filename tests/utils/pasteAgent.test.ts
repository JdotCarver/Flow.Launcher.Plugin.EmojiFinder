// tests/utils/pasteAgent.test.ts
//
// The agent is PowerShell and cannot run here, so these tests cover the parts that are ours
// and that have actually broken before: where the files live, what the script says, how a
// request is published, and how "is the agent alive" is answered.
//
// Every test writes into a temporary directory; nothing touches %LOCALAPPDATA%.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildAgentScript,
  ensureAgentScript,
  HEARTBEAT_STALE_AFTER_MILLISECONDS,
  readAgentStatus,
  requestPaste,
  resolveAgentPaths,
  type PasteAgentPaths
} from '../../src/utils/pasteAgent.js';

const temporaryDirectories: string[] = [];

function createPaths (): PasteAgentPaths {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-agent-test-'));
  temporaryDirectories.push(directory);

  return {
    directory,
    script: path.join(directory, 'paste-agent.ps1'),
    request: path.join(directory, 'request.json'),
    heartbeat: path.join(directory, 'heartbeat.txt'),
    log: path.join(directory, 'agent.log')
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveAgentPaths', () => {
  test('lives in %LOCALAPPDATA%, which is the same for installed and portable Flow Launcher', () => {
    const paths = resolveAgentPaths({ LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' } as NodeJS.ProcessEnv);

    expect(paths.script).toBe(
      path.join('C:\\Users\\someone\\AppData\\Local', 'Flow.Launcher.Plugin.EmojiFinder', 'paste-agent.ps1')
    );
  });

  test('falls back to the temp folder instead of throwing when the variable is missing', () => {
    const paths = resolveAgentPaths({ TEMP: 'C:\\Temp' } as NodeJS.ProcessEnv);

    expect(paths.directory.startsWith('C:\\Temp')).toBe(true);
  });
});

describe('buildAgentScript', () => {
  test('is a loop that waits for requests and heartbeats, not a one-shot run', () => {
    const script = buildAgentScript(createPaths());

    expect(script).toContain('while ($true)');
    expect(script).toContain('heartbeatPath');
    expect(script).toContain('request sequence=');
  });

  test('keeps the two focus signals and the clipboard comparison that were already proven', () => {
    const script = buildAgentScript(createPaths());

    expect(script).toContain("Get-Process -Name 'Flow.Launcher*'");
    expect(script).toContain('MainWindowHandle');
    expect(script).toContain('[\\uFE0E\\uFE0F\\u200D]');
    expect(script).toContain('SendWait(\'^v\')');
  });

  test('refuses to start a second copy, which would paste everything twice', () => {
    expect(buildAgentScript(createPaths())).toContain('already running as pid=');
  });

  test('escapes a path containing a quote instead of producing a broken script', () => {
    const paths = createPaths();
    const script = buildAgentScript({ ...paths, request: `${paths.request}' odd` });

    expect(script).toContain('odd');
    expect(script).not.toContain("''''");
  });

  test('reads the request file through .NET with an explicit UTF-8 encoding', () => {
    // Not Get-Content: its default encoding differs between Windows PowerShell 5.1 and
    // PowerShell 7, and under 5.1 an emoji arrives as its four UTF-8 bytes, the clipboard
    // never matches, and the agent silently does nothing. Explicit encodings cannot drift.
    const script = buildAgentScript(createPaths());

    expect(script).toContain('[System.IO.File]::ReadAllText($requestPath, [System.Text.Encoding]::UTF8)');
    expect(script).not.toContain('Get-Content -LiteralPath $requestPath');
  });

  test('writes the log and heartbeat as UTF-8 without a byte-order mark', () => {
    const script = buildAgentScript(createPaths());

    expect(script).toContain('New-Object System.Text.UTF8Encoding($false)');
    expect(script).toContain('[System.IO.File]::AppendAllText($logPath');
  });

  test('records which PowerShell host it is running under', () => {
    // 5.1 (powershell.exe) and 7 (pwsh) are different hosts with different defaults, and a
    // report that does not say which one ran cannot be compared with another.
    const script = buildAgentScript(createPaths());

    expect(script).toContain('host={1} ps={2} edition={3}');
  });

  test('always writes a log, so "did the request arrive" can be answered afterwards', () => {
    const paths = createPaths();

    expect(buildAgentScript(paths)).toContain(`$logPath = '${paths.log}'`);
  });
});

describe('requestPaste', () => {
  test('writes the emoji and a sequence number the agent can order', () => {
    const paths = createPaths();

    const first = requestPaste('🙈', paths);
    const written = JSON.parse(fs.readFileSync(paths.request, 'utf8')) as Record<string, unknown>;

    expect(written).toEqual({ emoji: '🙈', sequence: first.sequence });
  });

  test('a second request for the same emoji still counts as a new paste', () => {
    const paths = createPaths();

    const first = requestPaste('🙈', paths);
    const second = requestPaste('🙈', paths);

    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  test('leaves no half-written file behind', () => {
    const paths = createPaths();

    requestPaste('🙈', paths);

    expect(fs.existsSync(`${paths.request}.tmp`)).toBe(false);
  });

  test('reports an agent that is not running rather than pretending the paste happened', () => {
    const paths = createPaths();

    expect(requestPaste('🙈', paths).agentRunning).toBe(false);
  });
});

describe('readAgentStatus', () => {
  test('a fresh heartbeat means the agent is alive', () => {
    const paths = createPaths();
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.heartbeat, new Date().toISOString());

    expect(readAgentStatus(paths).running).toBe(true);
  });

  test('a heartbeat older than the stale limit means it is gone', () => {
    const paths = createPaths();
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.heartbeat, 'old');

    const old = new Date(Date.now() - HEARTBEAT_STALE_AFTER_MILLISECONDS - 1000);
    fs.utimesSync(paths.heartbeat, old, old);

    const status = readAgentStatus(paths);

    expect(status.running).toBe(false);
    expect(status.heartbeatAgeMilliseconds).toBeGreaterThan(HEARTBEAT_STALE_AFTER_MILLISECONDS);
  });

  test('no heartbeat at all means it has never run', () => {
    expect(readAgentStatus(createPaths())).toEqual({ running: false, heartbeatAgeMilliseconds: null });
  });
});

describe('ensureAgentScript', () => {
  test('writes the script next to the request file, creating the folder if needed', () => {
    const paths = createPaths();

    ensureAgentScript(paths);

    expect(fs.existsSync(paths.script)).toBe(true);
    expect(fs.readFileSync(paths.script, 'utf8')).toContain('waiting for requests');
  });

  test('does not rewrite an unchanged script', () => {
    const paths = createPaths();
    ensureAgentScript(paths);

    const before = fs.statSync(paths.script).mtimeMs;
    ensureAgentScript(paths);

    expect(fs.statSync(paths.script).mtimeMs).toBe(before);
  });
});
