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
