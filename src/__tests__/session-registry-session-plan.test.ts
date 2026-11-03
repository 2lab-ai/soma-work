/**
 * #853 / #855 — a Slack session's plan gate on the registry (plan mode on every session; the
 * dashboard task's own plan suite left with its stack — these are its Slack cases, kept).
 *
 *   P1 a Slack session in plan mode: saved (no SDK session yet), back after a restart, submitted
 *      and decided by its key; a failed save puts the previous gate back; a session not in plan
 *      mode, or none at all, is refused.
 *   P2 archive and revive keep the gate; load drops a malformed one and keeps a valid one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-session-plan-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const PLAN = {
  summary: '계획 모드를 넣는다',
  intent: '실행 전 확인',
  phases: [{ title: '서버', steps: [{ title: '게이트' }] }],
};

describe('SessionRegistry — a Slack session’s plan gate (#853, kept in #855)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('P1 — saved, back after a restart, submitted and decided by its key; a failed save puts it back', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C777', '1700000007.000100');
    const key = reg.getSessionKey('C777', '1700000007.000100');
    session.taskPlan = { state: 'drafting', revision: 0, updatedAt: 1 };
    reg.saveSessions();
    const gate = reg.submitSessionPlan(key, PLAN);
    expect(gate).toMatchObject({ state: 'awaiting', revision: 1, plan: { summary: '계획 모드를 넣는다' } });
    expect(session.taskPlan).toEqual(gate);
    // Saved though the session has no SDK session yet (the save filter keeps a plan-mode session).
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSession('C777', '1700000007.000100')?.taskPlan).toEqual(gate);

    reg.setSessionPlanGate(key, { ...gate, state: 'approved' });
    expect(session.taskPlan?.state).toBe('approved');
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.setSessionPlanGate(key, { ...gate, state: 'cancelled' })).toThrow('ENOSPC');
    expect(session.taskPlan?.state).toBe('approved');
    save.mockRestore();

    reg.createSession('U1', 'User', 'C778', '1700000008.000100');
    expect(() => reg.submitSessionPlan(reg.getSessionKey('C778', '1700000008.000100'), PLAN)).toThrow(
      /not a plan-mode session/,
    );
    expect(() => reg.setSessionPlanGate('work:C9:9.9', gate)).toThrow(/not a plan-mode session/);
  });

  it('P2 — archive and revive keep it; load drops a malformed gate and keeps a valid one', () => {
    const reg = new SessionRegistry();
    const session = reg.createSession('U1', 'User', 'C555', '1700000005.000100');
    const key = reg.getSessionKey('C555', '1700000005.000100');
    session.sessionId = 'sid-plan';
    session.taskPlan = { state: 'drafting', revision: 0, updatedAt: 1 };
    reg.saveSessions();
    const gate = reg.submitSessionPlan(key, PLAN);
    reg.terminateSession(key);
    const dir = path.join(TEST_DATA_DIR, 'archives');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    expect(file).toBeDefined();
    const archived = JSON.parse(fs.readFileSync(path.join(dir, file as string), 'utf8'));
    expect(archived.taskPlan).toEqual(gate);
    expect(reg.restoreArchivedSession(archived, `/tmp/U1/session_plan_${process.pid}`)).toMatchObject({ ok: true });
    expect(reg.getSession('C555', '1700000005.000100')?.taskPlan).toEqual(gate);

    reg.saveSessions();
    const records = (JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, any>>).map((r) => ({
      ...r,
      taskPlan: { state: 'nope' },
    }));
    const valid = { ...records[0], key: 'C556-1700000006.000100', channelId: 'C556', threadTs: '1700000006.000100' };
    delete (valid as Record<string, unknown>).taskId;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...records, { ...valid, taskPlan: gate }]));
    const loaded = new SessionRegistry();
    loaded.loadSessions();
    expect(loaded.getSession('C555', '1700000005.000100')?.taskPlan).toBeUndefined();
    expect(loaded.getSession('C556', '1700000006.000100')?.taskPlan).toEqual(gate);
  });
});
