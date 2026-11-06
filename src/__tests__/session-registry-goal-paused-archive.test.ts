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
