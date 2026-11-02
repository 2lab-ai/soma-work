/**
 * Plan mode (SSOT 2026-11-02) — a task's plan gate on the registry.
 *
 *   R1 a task made with the toggle on starts drafting; saved strictly, back after a restart.
 *   R2 without it: no gate, nothing saved.
 *   R3 `submitTaskPlan` saves the checked plan (awaiting, next revision); a refusal changes nothing.
 *   R4 `setTaskPlanGate` saves strictly; a failed save puts the previous gate back.
 *   R5 archive and revive keep the gate; load drops a malformed one and never gives a Slack session one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-task-plan-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';
import { TaskPlanError } from '../task-turn/task-plan';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const BASE = { ownerId: 'U1', ownerName: 'User', workingDirectory: '/work/U1/session_1' };
const savedOf = (taskId: string) =>
  (JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as Array<Record<string, any>>).find((r) => r.taskId === taskId);
const PLAN = {
  summary: '계획 모드를 넣는다',
  intent: '실행 전 확인',
  phases: [{ title: '서버', steps: [{ title: '게이트' }] }],
};

describe('SessionRegistry — a task’s plan gate (plan mode)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('R1 — the toggle on: drafting from the first save, back after a restart', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...BASE, planMode: true });
    expect(task.taskPlan).toMatchObject({ state: 'drafting', revision: 0 });
    expect(savedOf(task.taskId!)?.taskPlan).toMatchObject({ state: 'drafting', revision: 0 });
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(task.taskId!)?.taskPlan).toEqual(task.taskPlan);
  });

  it('R2 — the toggle off: no gate', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask(BASE);
    expect(task.taskPlan).toBeUndefined();
    expect(savedOf(task.taskId!)?.taskPlan).toBeUndefined();
  });

  it('R3 — a submission is saved awaiting the owner; refused ones change nothing', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...BASE, planMode: true });
    const gate = reg.submitTaskPlan(task.taskId!, PLAN);
    expect(gate).toMatchObject({
      state: 'awaiting',
      revision: 1,
      plan: { summary: '계획 모드를 넣는다', revision: 1 },
    });
    expect(task.taskPlan).toEqual(gate);
    expect(savedOf(task.taskId!)?.taskPlan).toEqual(gate);
    const after = new SessionRegistry();
    after.loadSessions();
    expect(after.getSessionByTaskId(task.taskId!)?.taskPlan).toEqual(gate);

    const before = fs.readFileSync(SESSIONS_FILE, 'utf8');
    expect(() => reg.submitTaskPlan(task.taskId!, { ...PLAN, phases: [] })).toThrow(TaskPlanError);
    reg.setTaskPlanGate(task.taskId!, { ...gate, state: 'approved' });
    const approved = fs.readFileSync(SESSIONS_FILE, 'utf8');
    expect(approved).not.toBe(before);
    expect(() => reg.submitTaskPlan(task.taskId!, PLAN)).toThrow(expect.objectContaining({ code: 'already-decided' }));
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).toBe(approved);
    // A task with no gate, or no task: refused.
    const plain = reg.createTask(BASE);
    expect(() => reg.submitTaskPlan(plain.taskId!, PLAN)).toThrow(/not a plan-mode task/);
    expect(() => reg.submitTaskPlan('99999999-9999-4999-8999-999999999999', PLAN)).toThrow(/not a plan-mode task/);
  });

  it('R4 — a failed save puts the previous gate back', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...BASE, planMode: true });
    const first = reg.submitTaskPlan(task.taskId!, PLAN);
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.setTaskPlanGate(task.taskId!, { ...first, state: 'approved' })).toThrow('ENOSPC');
    expect(task.taskPlan).toBe(first);
    expect(() => reg.submitTaskPlan(task.taskId!, { ...PLAN, summary: 'v2' })).toThrow('ENOSPC');
    expect(task.taskPlan).toBe(first);
    save.mockRestore();
  });

  it('R5 — archive and revive keep it; load drops a malformed gate and never gives a Slack session one', () => {
    const reg = new SessionRegistry();
    const task = reg.createTask({ ...BASE, planMode: true });
    const gate = reg.submitTaskPlan(task.taskId!, PLAN);
    reg.terminateSession(`task:${task.taskId}`);
    const dir = path.join(TEST_DATA_DIR, 'archives');
    const archived = JSON.parse(
      fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))!), 'utf8'),
    );
    expect(archived.taskPlan).toEqual(gate);
    expect(reg.restoreArchivedSession(archived, '/work/U1/session_1')).toMatchObject({ ok: true });
    expect(reg.getSessionByTaskId(task.taskId!)?.taskPlan).toEqual(gate);

    const record = (taskId: string, extra: Record<string, unknown>) => ({
      key: `task:${taskId}`,
      ownerId: 'U1',
      ownerName: 'User',
      userId: 'U1',
      channelId: '',
      slackless: true,
      taskId,
      isActive: true,
      lastActivity: new Date().toISOString(),
      workingDirectory: '/work/U1/session_1',
      state: 'MAIN',
      activityState: 'idle',
      ...extra,
    });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        record('55555550-5555-4555-8555-555555555555', { taskPlan: { state: 'nope' } }),
        record('55555551-5555-4555-8555-555555555555', { taskPlan: gate }),
        {
          key: 'C555-1700000005.000100',
          ownerId: 'U1',
          ownerName: 'User',
          userId: 'U1',
          channelId: 'C555',
          threadTs: '1700000005.000100',
          isActive: true,
          lastActivity: new Date().toISOString(),
          state: 'MAIN',
          activityState: 'idle',
          taskPlan: gate,
        },
      ]),
    );
    const loaded = new SessionRegistry();
    expect(loaded.loadSessions()).toBe(3);
    expect(loaded.getSessionByTaskId('55555550-5555-4555-8555-555555555555')?.taskPlan).toBeUndefined();
    expect(loaded.getSessionByTaskId('55555551-5555-4555-8555-555555555555')?.taskPlan).toEqual(gate);
    expect(loaded.getSession('C555', '1700000005.000100')?.taskPlan).toBeUndefined();
  });
});
