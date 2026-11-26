/**
 * .prd/39 D4 · D5 · I1 — the goal as stored. The judge's lease (`pendingEval`) is never written: a judge lives only in
 * the process that runs it. A completed goal lives in the history only: a record that still holds one in the slot
 * (written before D5, or by an older version) moves it to the history on load, one record per goal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  return { TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-goal-storage-test-${process.pid}`) };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));

import { phaseOf } from '@soma/slack/goal/read';
import { SessionRegistry } from '../session-registry';

const goalOf = (goalId: string, status: 'active' | 'complete', over: Record<string, unknown> = {}) => ({
  goalId,
  objective: goalId,
  status,
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'U1',
  continuationCount: 0,
  maxContinuations: 10,
  evalAttemptCount: 0,
  ...over,
});

const row = (over: Record<string, unknown>) => ({
  ownerId: 'U1',
  userId: 'U1',
  channelId: 'C-st',
  sessionId: 'sess-st',
  isActive: true,
  lastActivity: new Date().toISOString(),
  state: 'MAIN',
  ...over,
});

describe('SessionRegistry — the goal as stored (.prd/39 D4 · D5)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  it('D4: never writes the judge lease', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C-st', '1.001');
    session.sessionId = 'sess-lease';
    session.goal = goalOf('a', 'active', { pendingEval: { requestedAt: 1, turnId: 't' } }) as any;
    reg.saveSessions();

    const saved = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), 'utf8'));
    const stored = (Array.isArray(saved) ? saved : saved.sessions).find((s: any) => s.threadTs === '1.001');
    expect(stored.goal.goalId).toBe('a');
    expect('pendingEval' in stored.goal).toBe(false);
    // The live goal keeps its lease — only the stored copy drops it.
    expect(session.goal?.pendingEval).toEqual({ requestedAt: 1, turnId: 't' });
  });

  it('D5: a completed goal left in the slot by an older record moves to the history', () => {
    const done = goalOf('d', 'complete', { completedVia: 'eval-model' });
    fs.writeFileSync(
      path.join(TEST_DATA_DIR, 'sessions.json'),
      JSON.stringify([row({ key: 'C-st-2', threadTs: '1.002', goal: done, goalHistory: [] })]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const session = reg.getSession('C-st', '1.002');
    expect(session?.goal).toBeUndefined();
    expect(session?.goalHistory).toEqual([expect.objectContaining({ goalId: 'd', completedVia: 'eval-model' })]);
  });

  /**
   * A27 — three round trips through the stored shape. "Old version" = a build that does not know `phase` / `phaseFp`:
   * it keeps the fields it does not read and writes back the goal object it loaded, changing only legacy fields.
   */
  describe('A27 — round trips (D17)', () => {
    const roundTrip = (goal: Record<string, unknown>, oldVersion?: (g: any) => void) => {
      const reg = new SessionRegistry();
      const session = reg.createSession('U1', 'User', 'C-rt', '2.001');
      session.sessionId = 'sess-rt';
      session.goal = goal as any;
      reg.saveSessions();
      if (oldVersion) {
        const file = path.join(TEST_DATA_DIR, 'sessions.json');
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        const rows = Array.isArray(saved) ? saved : saved.sessions;
        oldVersion(rows.find((s: any) => s.threadTs === '2.001').goal);
        fs.writeFileSync(file, JSON.stringify(saved));
      }
      const next = new SessionRegistry();
      next.loadSessions();
      return next.getSession('C-rt', '2.001')?.goal as any;
    };
    const stopped = () =>
      goalOf('s', 'active', {
        epoch: 4,
        updatedAt: 40,
        continuationCount: 3,
        phase: { kind: 'stopped', why: 'resume-failed', at: 41 },
      });

    it('new → new, nothing changed: stopped stays stopped', () => {
      expect(roundTrip(stopped()).phase).toEqual({ kind: 'stopped', why: 'resume-failed', at: 41 });
    });

    it('new → old (nothing changed) → new: stopped stays stopped', () => {
      expect(roundTrip(stopped(), () => undefined).phase).toEqual({ kind: 'stopped', why: 'resume-failed', at: 41 });
    });

    it('new → old (goal max: the epoch moved) → new: stopped lapses, the goal runs', () => {
      const loaded = roundTrip(stopped(), (g) => {
        g.maxContinuations = 20;
        g.epoch = 5;
      });
      expect(loaded.phase).toBeUndefined();
      expect(phaseOf(loaded)).toEqual({ kind: 'running' });
    });

    it('new → old (the first turn reached the model: only openingPending cleared) → new: running, not opening', () => {
      const loaded = roundTrip(goalOf('o', 'active', { openingPending: true }), (g) => {
        g.openingPending = undefined;
      });
      expect(phaseOf(loaded)).toEqual({ kind: 'running' });
    });

    it('new → old (a judge retry armed: only the retry fields) → new: retrying', () => {
      const loaded = roundTrip(goalOf('r', 'active'), (g) => {
        g.evalBackoffUntil = 999;
        g.evalDispatchRetryCount = 1;
      });
      expect(phaseOf(loaded)).toMatchObject({ kind: 'retrying', until: 999, attempt: 1 });
    });

    it('an id-less legacy cap round stays id-less: its old DM buttons can still answer', () => {
      const loaded = roundTrip(goalOf('c', 'active', { continuationCount: 10, capDmPendingAt: 7 }));
      expect(loaded.capDecisionId).toBeUndefined();
      expect(phaseOf(loaded)).toEqual({
        kind: 'asking',
        ask: { kind: 'cap', roundId: undefined, openedAt: 7, dmRef: undefined },
      });
    });

    it('stored phases with a legacy form are not trusted over the legacy fields', () => {
      // A record that says asking(cap) while its legacy fields hold no question: the fields win (running).
      const loaded = roundTrip(goalOf('x', 'active'), (g) => {
        g.phase = { kind: 'asking', ask: 'cap' };
      });
      expect(phaseOf(loaded)).toEqual({ kind: 'running' });
    });
  });

  it('D5: the slot and the history holding the same goal become one record', () => {
    const done = goalOf('d', 'complete');
    fs.writeFileSync(
      path.join(TEST_DATA_DIR, 'sessions.json'),
      JSON.stringify([row({ key: 'C-st-3', threadTs: '1.003', goal: done, goalHistory: [done] })]),
    );
    const reg = new SessionRegistry();
    reg.loadSessions();
    const session = reg.getSession('C-st', '1.003');
    expect(session?.goal).toBeUndefined();
    expect(session?.goalHistory).toHaveLength(1);
  });
});
