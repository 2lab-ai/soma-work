import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(
    process.env.TMPDIR ?? require('os').tmpdir(),
    'soma-work-session-registry-task-usage-test',
  ),
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-task-usage-test');

/**
 * RED (SSOT T3) — the task total is the card's for the whole task: it is saved
 * with the session and `resetSessionContext` (/new, CONTINUE_SESSION) leaves it.
 * A session saved before the total existed, that had already spent, is marked
 * partial — the card says since when it counts instead of passing it off as the
 * whole task.
 */
describe('SessionRegistry — taskUsage persistence', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });
  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  const total = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheCreateTokens: 40, costUsd: 1.5 };

  it('round-trips taskUsage through save + load; garbage is dropped', () => {
    const writer = new SessionRegistry();
    const a = writer.createSession('U1', 'Tester', 'C1', '171.201');
    a.taskUsage = { ...total };
    const b = writer.createSession('U1', 'Tester', 'C1', '171.202');
    (b as any).taskUsage = { inputTokens: 'lots' };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.201')?.taskUsage).toEqual(total);
    expect(reader.getSession('C1', '171.202')?.taskUsage).toBeUndefined();
  });

  it('a session saved before taskUsage existed, that had spent, loads a partial total that counts from now', () => {
    const writer = new SessionRegistry();
    const s = writer.createSession('U1', 'Tester', 'C1', '171.203');
    s.sessionId = 'sdk-A';
    s.sdkUsageBaseline = {
      sdkSessionId: 'sdk-A',
      models: {
        opus: { inputTokens: 5, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.1 },
      },
    };
    writer.saveSessions();

    const before = Date.now();
    const reader = new SessionRegistry();
    reader.loadSessions();
    const t = reader.getSession('C1', '171.203')?.taskUsage;
    expect(t).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0 });
    expect(t?.partialSince).toBeGreaterThanOrEqual(before);
  });

  it('resetSessionContext clears the runtime usage but keeps the task total', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.204');
    s.sessionId = 'sdk-A';
    s.taskUsage = { ...total };
    (s as any).usage = { totalCostUsd: 1.5 };
    reg.resetSessionContext('C1', '171.204');
    expect((s as any).usage).toBeUndefined();
    expect(s.taskUsage).toEqual(total);
  });
});
