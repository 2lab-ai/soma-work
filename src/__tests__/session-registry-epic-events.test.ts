/**
 * E4 ⑤ — what a Slack child owes its epic, recorded on the registry (.prd/19 D6, #854).
 *
 *   V1 a child's chain end (`recordSessionChainEnd`) is one event on its epic,
 *      in the same strict save as the child's last outcome; a failed save puts
 *      both back and throws. No child text reaches the epic.
 *   V3 every chain end is its own event, with its outcome; the child's last
 *      outcome names the category of that end.
 *   V6 a child whose epic is gone: dropped and logged, the child's outcome still
 *      saves. A session that is no child records nothing.
 *
 * #855 — the dashboard-task stack was removed, and with it the cases of a held
 * (unsaved) task-turn outcome (V2), a task chain's `/compact` hops (V3's hops),
 * the restart reconciliation of a lost task turn (V4–V4d) and approvals as
 * `needs-input` events (V5).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-epic-events-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));
vi.mock('../conversation/storage', () => ({
  ConversationStorage: class {
    async buildThreadIndex() {
      return new Map();
    }
  },
}));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';
import type { EpicEvent, TurnOutcomeRecord } from '../types';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const readSaved = (): Array<Record<string, any>> => JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
const savedOf = (taskId: string) => readSaved().find((r) => r.taskId === taskId);

const EPIC_TS = '1700000000.000100';
const CHILD_TS = '1700000001.000100';
const PLAIN_TS = '1700000002.000100';
const PLAN = { nodes: [{ id: 'login', title: '로그인 고치기', kind: 'issue' as const }] };
const SECRET = 'Error: secret path /home/x leaked';

function epicIn(reg: SessionRegistry, owner = 'U1') {
  const session = reg.createSession(owner, 'User', 'C1', EPIC_TS);
  const key = reg.getSessionKey('C1', EPIC_TS);
  reg.makeEpic(key);
  reg.setEpicPlan(session.taskId as string, PLAN, 'epic');
  return { epic: session, key };
}

function childIn(reg: SessionRegistry, epicTaskId: string, ts = CHILD_TS, owner = 'U1') {
  const childId = reg.reserveEpicChild(epicTaskId, 'login');
  const child = reg.createSession(owner, 'User', 'C1', ts);
  const key = reg.getSessionKey('C1', ts);
  reg.bindEpicChild(key, { taskId: childId, parentTaskId: epicTaskId, planNodeId: 'login' });
  return { child, key, childId };
}

describe('SessionRegistry — a Slack child reports to its epic (E4 ⑤)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'archives'), { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('V1 — a chain end is one event on the epic, in the same save as the child’s outcome; a failed save puts both back', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const { child, key, childId } = childIn(reg, epic.taskId!);

    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    expect(() => reg.recordSessionChainEnd(key, { outcome: 'failed', reason: SECRET, at: 2000 })).toThrow('ENOSPC');
    save.mockRestore();
    expect(epic.epicEvents).toBeUndefined();
    expect(child.lastTurnOutcome).toBeUndefined();

    reg.recordSessionChainEnd(key, { outcome: 'failed', reason: SECRET, at: 2000 });
    const expected: EpicEvent = {
      id: `${childId}:chain:2000`,
      childTaskId: childId,
      planNodeId: 'login',
      outcome: 'failed',
      turnId: 'chain:2000',
      at: 2000,
      state: 'pending',
    };
    expect(epic.epicEvents).toEqual([expected]);
    expect(savedOf(epic.taskId!)?.epicEvents).toEqual([expected]);
    const outcome: TurnOutcomeRecord = {
      turnId: 'chain:2000',
      outcome: 'failed',
      category: 'Exception',
      reason: SECRET,
      at: 2000,
    };
    expect(child.lastTurnOutcome).toEqual(outcome);
    expect(savedOf(childId)?.lastTurnOutcome).toEqual(outcome);
    // The reason (a thrown message) stays the child's: it is never carried to the epic.
    expect(JSON.stringify(savedOf(epic.taskId!))).not.toContain('secret');
  });

  it('V3 — every chain end is its own event with its outcome; the child’s last outcome names the end’s category', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const { child, key, childId } = childIn(reg, epic.taskId!);
    const ends = [
      ['completed', 'WorkflowComplete'],
      ['waiting', 'UIUserAskQuestion'],
      ['failed', 'Exception'],
      ['cancelled', 'Stalled'],
      ['interrupted', 'Stalled'],
    ] as const;
    ends.forEach(([outcome, category], i) => {
      const at = 3000 + i;
      reg.recordSessionChainEnd(key, { outcome, at });
      expect(child.lastTurnOutcome, outcome).toEqual({ turnId: `chain:${at}`, outcome, category, at });
    });
    expect((epic.epicEvents ?? []).map((e) => [e.id, e.outcome, e.state])).toEqual(
      ends.map(([outcome], i) => [`${childId}:chain:${3000 + i}`, outcome, 'pending']),
    );
    expect(savedOf(epic.taskId!)?.epicEvents).toHaveLength(ends.length);
  });

  it('V6 — no live epic: dropped and logged, the child’s outcome still saves; a session that is no child records nothing', () => {
    const reg = new SessionRegistry();
    const { epic } = epicIn(reg);
    const { key, childId } = childIn(reg, epic.taskId!);
    const warn = vi.spyOn((reg as any).logger, 'warn');
    epic.terminated = true;
    reg.recordSessionChainEnd(key, { outcome: 'failed', reason: SECRET, at: 2000 });
    expect(epic.epicEvents).toBeUndefined();
    expect(savedOf(childId)?.lastTurnOutcome).toMatchObject({ outcome: 'failed', turnId: 'chain:2000' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Epic event dropped'),
      expect.objectContaining({ childTaskId: childId, parentTaskId: epic.taskId }),
    );

    warn.mockClear();
    const plain = reg.createSession('U1', 'User', 'C1', PLAIN_TS);
    plain.sessionId = 'sdk-plain';
    const save = vi.spyOn(reg as any, 'saveSessionsOrThrow');
    reg.recordSessionChainEnd(reg.getSessionKey('C1', PLAIN_TS), { outcome: 'failed', at: 3000 });
    // The epic itself is no child either.
    reg.recordSessionChainEnd(reg.getSessionKey('C1', EPIC_TS), { outcome: 'failed', at: 3000 });
    expect(save).not.toHaveBeenCalled();
    expect(plain.lastTurnOutcome).toBeUndefined();
    expect(epic.lastTurnOutcome).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Epic event'), expect.anything());
    expect(readSaved().every((r) => r.epicEvents === undefined)).toBe(true);
  });
});
