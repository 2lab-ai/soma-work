/**
 * Paused goals survive the archive (SSOT 2026-11-06, trinity review P2).
 *
 * A paused goal waits for its owner — an idle session is its normal state, so
 * the session sleeps and is archived while the goal waits. The archive keeps
 * the paused goals and a revive puts them back, still paused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-goal-paused-archive-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { SessionRegistry } from '../session-registry';

describe('SessionRegistry — paused goals across archive and revive', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
  });

  it('the archive keeps the paused goals and a revive puts them back, still paused', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C900', '1700000009.000100');
    const key = reg.getSessionKey('C900', '1700000009.000100');
    session.sessionId = 'sid-paused';
    session.goalPaused = [
      {
        goalId: 'p1',
        objective: '쉬는 목표',
        status: 'paused',
        createdAt: 1,
        updatedAt: 2,
        createdBy: 'U1',
        continuationCount: 4,
        maxContinuations: 10,
        evalAttemptCount: 0,
        activeMsUsed: 1234,
      },
    ];
    reg.saveSessions();
    reg.terminateSession(key);

    const dir = path.join(TEST_DATA_DIR, 'archives');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    expect(file).toBeDefined();
    const archived = JSON.parse(fs.readFileSync(path.join(dir, file as string), 'utf8'));
    expect(archived.goalPaused).toEqual([expect.objectContaining({ goalId: 'p1', status: 'paused' })]);

    expect(reg.restoreArchivedSession(archived, `/tmp/U1/session_paused_${process.pid}`)).toMatchObject({ ok: true });
    const revived = reg.getSession('C900', '1700000009.000100');
    expect(revived?.goal).toBeUndefined();
    expect(revived?.goalPaused).toEqual([
      expect.objectContaining({ goalId: 'p1', status: 'paused', continuationCount: 4, activeMsUsed: 1234 }),
    ]);
  });
});

const goalOf = (goalId: string, status: 'active' | 'queued' | 'paused' | 'complete') => ({
  goalId,
  objective: goalId,
  status,
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'U1',
  continuationCount: 0,
  maxContinuations: 10,
});

/**
 * .prd/39 D11 · A11 (X11) — the archive keeps the queue too: a queued goal waits for the goal ahead of it, and a revive
 * must not lose it. (#32ccac71 fixed only the paused goals.)
 */
describe('SessionRegistry — queued goals across archive and revive (X11)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
  });

  it('the archive keeps the queued goals and a revive puts them back, still queued', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C901', '1700000010.000100');
    const key = reg.getSessionKey('C901', '1700000010.000100');
    session.sessionId = 'sid-queued';
    session.goalQueue = [goalOf('q1', 'queued')];
    reg.saveSessions();
    reg.terminateSession(key);

    const dir = path.join(TEST_DATA_DIR, 'archives');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    const archived = JSON.parse(fs.readFileSync(path.join(dir, file as string), 'utf8'));
    expect(archived.goalQueue).toEqual([expect.objectContaining({ goalId: 'q1', status: 'queued' })]);

    expect(reg.restoreArchivedSession(archived, `/tmp/U1/session_queued_${process.pid}`)).toMatchObject({ ok: true });
    expect(reg.getSession('C901', '1700000010.000100')?.goalQueue).toEqual([
      expect.objectContaining({ goalId: 'q1', status: 'queued' }),
    ]);
  });
});

/**
 * Review #1494 · X9 — a restored archive is a new generation of its goal: the epoch moves through bumpEpoch, so the
 * judge's lease and a retry window armed for the old epoch end with it (the card would advertise a re-check that
 * never runs).
 */
describe('SessionRegistry — a restored goal starts a new generation (X9)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
  });

  it('advances the epoch and drops the lease and the retry window', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C902', '1700000020.000100');
    const key = reg.getSessionKey('C902', '1700000020.000100');
    session.sessionId = 'sid-retry';
    session.goal = goalOf('g-r', 'active') as any;
    reg.saveSessions();
    reg.terminateSession(key);

    const dir = path.join(TEST_DATA_DIR, 'archives');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    const archived = JSON.parse(fs.readFileSync(path.join(dir, file as string), 'utf8'));
    archived.goal = {
      ...archived.goal,
      epoch: 6,
      pendingEval: { requestedAt: 1, turnId: 't' },
      evalBackoffUntil: Date.now() + 60_000,
      evalRetryReason: 'pool busy',
    };

    expect(reg.restoreArchivedSession(archived, `/tmp/U1/session_retry_${process.pid}`)).toMatchObject({ ok: true });
    const goal = reg.getSession('C902', '1700000020.000100')?.goal;
    expect(goal?.epoch).toBe(7);
    expect(goal?.pendingEval).toBeUndefined();
    expect(goal?.evalBackoffUntil).toBeUndefined();
    expect(goal?.evalRetryReason).toBeUndefined();
  });
});

/**
 * .prd/39 D11 · A10 (X10) — `/new` (and `/renew`) start a fresh conversation: the slot, the queue and the shelf are
 * cleared, the history stays. Before, only the slot was cleared, so the next restart's stranded-queue repair promoted
 * the old conversation's queued goal into the new one.
 */
describe('SessionRegistry — /new clears the queue and the shelf (X10)', () => {
  it('leaves no goal in the slot, the queue or the shelf; keeps the history', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C902', '1700000011.000100');
    session.goal = goalOf('a', 'active');
    session.goalQueue = [goalOf('b', 'queued')];
    session.goalPaused = [goalOf('p', 'paused')];
    session.goalHistory = [goalOf('h', 'complete')];

    expect(reg.resetSessionContext('C902', '1700000011.000100')).toBe(true);

    expect(session.goal).toBeUndefined();
    expect(session.goalQueue ?? []).toEqual([]);
    expect(session.goalPaused ?? []).toEqual([]);
    expect(session.goalHistory).toEqual([expect.objectContaining({ goalId: 'h' })]);
  });
});
