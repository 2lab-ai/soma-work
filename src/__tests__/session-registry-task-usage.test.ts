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

import { getArchiveStore, SessionArchiveStore } from '../session-archive';
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

  it('a session archived while loading keeps its task total for the closed card (review r1)', () => {
    const writer = new SessionRegistry();
    const s = writer.createSession('U1', 'Tester', 'C1', '171.205');
    s.sessionId = 'sdk-arch';
    s.state = 'MAIN';
    s.taskUsage = { ...total };
    writer.saveSessions();
    // Asleep since an unknown time: past the archive limit, so load archives it.
    const file = path.join(TEST_DATA_DIR, 'sessions.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const x of saved) {
      x.state = 'SLEEPING';
      delete x.sleepStartedAt;
    }
    fs.writeFileSync(file, JSON.stringify(saved));
    new SessionRegistry().loadSessions();
    const archived = getArchiveStore()
      .listRecent(24 * 60 * 60 * 1000)
      .find((a) => a.sessionId === 'sdk-arch');
    expect(archived?.taskUsage).toEqual(total);
  });

  it('review r1 — a session saved before baselines existed (SDK session, no baseline) also loads a partial total', () => {
    const writer = new SessionRegistry();
    const s = writer.createSession('U1', 'Tester', 'C1', '171.206');
    s.sessionId = 'sdk-old';
    writer.saveSessions();
    const reader = new SessionRegistry();
    reader.loadSessions();
    expect(reader.getSession('C1', '171.206')?.taskUsage?.partialSince).toBeGreaterThan(0);
  });

  it('review r1 — archiving a session mid-turn keeps the calls its running turn already made', () => {
    const reg = new SessionRegistry();
    const s = reg.createSession('U1', 'Tester', 'C1', '171.207');
    s.sessionId = 'sdk-live';
    s.model = 'claude-opus-5-5[1m]';
    s.taskUsage = { ...total };
    (s as any).liveUsage = { 'm:a': { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheCreateTokens: 8 } };
    // A store of its own: the shared one remembers a directory beforeEach removed.
    const store = new SessionArchiveStore(path.join(TEST_DATA_DIR, 'archives-mid-turn'));
    store.archive(s as any, 'C1:171.207', 'terminated');
    const archived = store.listRecent(24 * 60 * 60 * 1000).find((a) => a.sessionId === 'sdk-live');
    expect(archived?.taskUsage).toMatchObject({
      inputTokens: 15,
      outputTokens: 26,
      cacheReadTokens: 307,
      cacheCreateTokens: 48,
    });
    expect(archived!.taskUsage!.costUsd).toBeGreaterThan(1.5);
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
