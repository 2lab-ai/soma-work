/**
 * The goal's cap decision ("Goal 계속 진행할까요?") is ONE request with two
 * answer surfaces — the owner's Slack DM and the dashboard's approval card.
 * An answer on either surface resolves both (SSOT T1/T2: "아무데서나 수락하면
 * 둘다 수락 처리"); a round that ends without an answer retires its DM.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../../env-paths';
import type { ConversationSession, SessionGoal } from '../../types';

vi.mock('../goal-loop-resume', () => ({ resumeGoalLoop: vi.fn() }));
const io = vi.hoisted(() => ({ failJournalWrites: false }));
vi.mock('@soma/common/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@soma/common/atomic-json')>();
  return {
    ...actual,
    atomicWriteJson: (file: string, value: unknown, options?: unknown) => {
      if (io.failJournalWrites) throw new Error('disk full');
      return actual.atomicWriteJson(file, value, options as never);
    },
  };
});

import {
  answerGoalCapDecision,
  dmRefOf,
  flushGoalCapDmSync,
  GOAL_CAP_DECISION_SUPERSEDED_TEXT,
  goalCapDecisionResolvedText,
  openGoalCapDecision,
  pendingGoalCapDmRewrites,
  recordGoalCapDm,
  reloadGoalCapDmRewrites,
  retireGoalCapDecision,
  setGoalCapDecisionSurfaces,
} from '../goal-cap-decision';
import { resetGoalContinuationOnUserMessage } from '../goal-continuation';
import { resumeGoalLoop } from '../goal-loop-resume';

const resume = vi.mocked(resumeGoalLoop);
const KEY = 'C1:T1';
const DM = { channel: 'D-owner', ts: '1700000000.000100' };

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-1',
    objective: 'ship the dashboard card',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U-owner',
    continuationCount: 10,
    maxContinuations: 10,
    epoch: 3,
    ...overrides,
  };
}

/** A goal whose cap decision is open and whose DM landed. */
function pendingGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  const g = goal(overrides);
  openGoalCapDecision(g, 1000);
  expect(recordGoalCapDm(g, g.capDecisionId as string, DM)).toBe('recorded');
  return g;
}

function session(g: SessionGoal): ConversationSession {
  return { goal: g, systemPrompt: 'cached' } as unknown as ConversationSession;
}

let updates: Array<{ ref: { channel: string; ts: string }; text: string }>;
let broadcasts: number;
let failNextUpdates: number;

/** The DM-rewrite store on disk, read fresh (what the next process would load). */
function rewritesOnDisk(): Array<{ channel: string; ts: string; text: string }> {
  const file = path.join(DATA_DIR, 'goal-cap-dm-sync.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
}

beforeEach(() => {
  resume.mockClear();
  updates = [];
  broadcasts = 0;
  failNextUpdates = 0;
  io.failJournalWrites = false;
  fs.rmSync(path.join(DATA_DIR, 'goal-cap-dm-sync.json'), { force: true });
  fs.rmSync(path.join(DATA_DIR, 'goal-cap-dm-sync.json.bak'), { force: true });
  reloadGoalCapDmRewrites();
  setGoalCapDecisionSurfaces({
    updateDm: async (ref, text) => {
      if (failNextUpdates > 0) {
        failNextUpdates--;
        throw new Error('slack down');
      }
      updates.push({ ref, text });
    },
    broadcast: () => {
      broadcasts++;
    },
  });
});

afterEach(() => {
  setGoalCapDecisionSurfaces(null);
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('openGoalCapDecision — the round', () => {
  it('opens once per cap event with a fresh unique round id (T1)', () => {
    const g = goal();
    expect(openGoalCapDecision(g, 1000)).toBe(true);
    const first = g.capDecisionId;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(g.capDmPendingAt).toBe(1000);
    // Already pending: same round.
    expect(openGoalCapDecision(g, 2000)).toBe(false);
    expect(g.capDecisionId).toBe(first);
    // A new round after the old one ended gets a different id even in the same millisecond.
    retireGoalCapDecision(g);
    expect(openGoalCapDecision(g, 1000)).toBe(true);
    expect(g.capDecisionId).not.toBe(first);
  });
});

describe('answerGoalCapDecision — one answer path for both surfaces', () => {
  it('a dashboard Continue resumes the goal AND rewrites the owner DM (T2)', async () => {
    const g = pendingGoal();
    const save = vi.fn();
    const s = session(g);
    const result = answerGoalCapDecision({
      session: s,
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'dashboard',
      save,
    });
    expect(result.ok).toBe(true);
    expect(g.continuationCount).toBe(0);
    expect(g.status).toBe('active');
    expect(g.capDmPendingAt).toBeUndefined();
    expect(g.capDecisionId).toBeUndefined();
    expect(g.epoch).toBe(4);
    expect(s.systemPrompt).toBeUndefined();
    expect(save).toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith(KEY);
    expect(broadcasts).toBe(1);
    await flush();
    expect(updates).toEqual([{ ref: DM, text: goalCapDecisionResolvedText('continue', 'dashboard') }]);
    expect(updates[0].text).toContain('대시보드에서 응답');
    expect(pendingGoalCapDmRewrites()).toEqual([]);
  });

  it('a dashboard Cancel pauses the goal and rewrites the DM without buttons (T2)', async () => {
    const g = pendingGoal();
    const result = answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'cancel',
      surface: 'dashboard',
      save: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(g.status).toBe('paused');
    expect(resume).not.toHaveBeenCalled();
    await flush();
    expect(updates[0].text).toContain('중단');
  });

  it('a Slack answer also queues a durable DM rewrite (its respond() can fail) and pushes the board (T2)', async () => {
    const g = pendingGoal();
    const result = answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'slack',
      save: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(broadcasts).toBe(1);
    await flush();
    expect(updates).toEqual([{ ref: DM, text: goalCapDecisionResolvedText('continue', 'slack') }]);
  });

  it('answers at most once across surfaces: the second answer is stale and changes nothing (T2)', () => {
    const g = pendingGoal();
    const s = session(g);
    const id = g.capDecisionId;
    const first = answerGoalCapDecision({
      session: s,
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: id,
      actor: 'U-owner',
      decision: 'cancel',
      surface: 'dashboard',
      save: vi.fn(),
    });
    const second = answerGoalCapDecision({
      session: s,
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: id,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'slack',
      save: vi.fn(),
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'stale' });
    expect(g.status).toBe('paused');
    expect(resume).not.toHaveBeenCalled();
  });

  it('a button from an earlier round never answers a later round of the same goal', () => {
    const g = pendingGoal();
    const oldRound = g.capDecisionId;
    retireGoalCapDecision(g); // a user message ended round 1
    openGoalCapDecision(g, 5000); // the goal hits its budget again
    const result = answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: oldRound,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'slack',
      save: vi.fn(),
    });
    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(g.capDmPendingAt).toBe(5000);
  });

  it('only the goal owner answers', () => {
    const g = pendingGoal();
    const result = answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-admin',
      decision: 'continue',
      surface: 'dashboard',
      save: vi.fn(),
    });
    expect(result).toEqual({ ok: false, reason: 'not_owner' });
    expect(g.capDmPendingAt).toBe(1000);
    expect(
      answerGoalCapDecision({
        session: session(g),
        sessionKey: KEY,
        goalId: 'goal-1',
        decisionId: g.capDecisionId,
        actor: undefined,
        decision: 'continue',
        surface: 'dashboard',
        save: vi.fn(),
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a button from before round ids existed answers only a round that has no id', () => {
    const legacy = goal({ capDmPendingAt: 1000 });
    const ok = answerGoalCapDecision({
      session: session(legacy),
      sessionKey: KEY,
      goalId: 'goal-1',
      actor: 'U-owner',
      decision: 'continue',
      surface: 'slack',
      save: vi.fn(),
    });
    expect(ok.ok).toBe(true);
    // A new round whose DM has not landed yet (no ref) still refuses an id-less button (review gate P1).
    const fresh = goal();
    openGoalCapDecision(fresh, 2000);
    expect(fresh.capDmRef).toBeUndefined();
    const stale = answerGoalCapDecision({
      session: session(fresh),
      sessionKey: KEY,
      goalId: 'goal-1',
      actor: 'U-owner',
      decision: 'continue',
      surface: 'slack',
      save: vi.fn(),
    });
    expect(stale).toEqual({ ok: false, reason: 'stale' });
    expect(fresh.continuationCount).toBe(10);
  });

  it('the decision is persisted before the loop is kicked (a crash after the save is recovered by the restart resume)', () => {
    const g = pendingGoal();
    const order: string[] = [];
    resume.mockImplementation(() => {
      order.push('resume');
    });
    answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'dashboard',
      save: () => {
        order.push(`save:pending=${g.capDmPendingAt !== undefined}`);
      },
    });
    expect(order).toEqual(['save:pending=false', 'resume']);
  });
});

describe('DM sync — rewrites survive failures and restarts', () => {
  it('a failed rewrite stays in the store and is retried until it lands', async () => {
    vi.useFakeTimers();
    const g = pendingGoal();
    failNextUpdates = 1;
    answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'dashboard',
      save: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    // The decision stands; the rewrite waits, on disk.
    expect(g.capDmPendingAt).toBeUndefined();
    expect(rewritesOnDisk()).toEqual([expect.objectContaining(DM)]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates).toHaveLength(1);
    expect(rewritesOnDisk()).toEqual([]);
  });

  it('after a restart, a rewrite the previous process could not deliver is sent again', async () => {
    vi.useFakeTimers();
    const g = pendingGoal();
    failNextUpdates = 10;
    retireGoalCapDecision(g);
    await vi.advanceTimersByTimeAsync(2_000 + 15_000 + 60_000);
    expect(updates).toEqual([]);
    // "Restart": a fresh process loads the store and flushes it.
    reloadGoalCapDmRewrites();
    failNextUpdates = 0;
    expect(flushGoalCapDmSync()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toEqual([{ ref: DM, text: GOAL_CAP_DECISION_SUPERSEDED_TEXT }]);
    expect(rewritesOnDisk()).toEqual([]);
  });
});

describe('retireGoalCapDecision — a round that ends without an answer', () => {
  it('a real user message ends the round on both surfaces: the DM loses its buttons (T2)', async () => {
    const g = pendingGoal();
    resetGoalContinuationOnUserMessage({ goal: g });
    expect(g.capDmPendingAt).toBeUndefined();
    expect(g.capDmRef).toBeUndefined();
    await flush();
    expect(updates).toEqual([{ ref: DM, text: GOAL_CAP_DECISION_SUPERSEDED_TEXT }]);
    expect(broadcasts).toBe(1);
  });

  it('a DM that lands after its round ended is rewritten at once', async () => {
    const g = goal();
    openGoalCapDecision(g, 1000);
    const round = g.capDecisionId as string;
    retireGoalCapDecision(g); // answered on the dashboard while the DM was in flight
    expect(recordGoalCapDm(g, round, DM)).toBe('late');
    await flush();
    expect(updates).toEqual([{ ref: DM, text: GOAL_CAP_DECISION_SUPERSEDED_TEXT }]);
  });
});

describe('dmRefOf', () => {
  it('reads chat.postMessage results only', () => {
    expect(dmRefOf({ channel: 'D1', ts: '1.2', echoedMessage: false })).toEqual({ channel: 'D1', ts: '1.2' });
    expect(dmRefOf(undefined)).toBeUndefined();
    expect(dmRefOf({ ts: '1.2' })).toBeUndefined();
  });
});

describe('DM sync durability (review gate P1)', () => {
  it('a retirement writes its rewrite to the store before the first attempt can fail', async () => {
    const g = pendingGoal();
    failNextUpdates = 10;
    retireGoalCapDecision(g);
    // Synchronously on disk — a crash right now still leaves it for the next process.
    expect(rewritesOnDisk()).toEqual([
      { ...DM, text: GOAL_CAP_DECISION_SUPERSEDED_TEXT, decisionId: expect.any(String) },
    ]);
  });

  it('a late DM (answered on the dashboard while the post was in flight) is on disk too', () => {
    const g = goal();
    openGoalCapDecision(g, 1000);
    const round = g.capDecisionId as string;
    retireGoalCapDecision(g);
    failNextUpdates = 10;
    expect(recordGoalCapDm(g, round, DM)).toBe('late');
    expect(rewritesOnDisk()).toEqual([
      { ...DM, text: GOAL_CAP_DECISION_SUPERSEDED_TEXT, decisionId: expect.any(String) },
    ]);
  });

  it("a newer round's rewrite never overwrites an older DM's pending rewrite — both reach Slack", async () => {
    vi.useFakeTimers();
    const g = pendingGoal();
    failNextUpdates = 10;
    answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'dashboard',
      save: vi.fn(),
    });
    openGoalCapDecision(g, 9000);
    const DM2 = { channel: 'D-owner', ts: '1700000999.000200' };
    recordGoalCapDm(g, g.capDecisionId as string, DM2);
    retireGoalCapDecision(g);
    expect(rewritesOnDisk().map((e) => e.ts)).toEqual([DM.ts, DM2.ts]);
    failNextUpdates = 0;
    reloadGoalCapDmRewrites();
    flushGoalCapDmSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.map((u) => u.ref.ts).sort()).toEqual([DM.ts, DM2.ts].sort());
    expect(rewritesOnDisk()).toEqual([]);
  });

  it('a pending rewrite survives the goal being deleted from the session', () => {
    const s = { goal: pendingGoal() } as { goal?: SessionGoal };
    failNextUpdates = 10;
    retireGoalCapDecision(s.goal);
    s.goal = undefined; // the goal is gone (deleted / archived)
    reloadGoalCapDmRewrites();
    expect(pendingGoalCapDmRewrites()).toEqual([expect.objectContaining(DM)]);
  });
});

describe('journal before the session (review gate round 2 P1)', () => {
  it('the DM rewrite is on disk BEFORE the decision is saved', () => {
    const g = pendingGoal();
    let journalAtSave: unknown[] = [];
    answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'dashboard',
      save: () => {
        journalAtSave = rewritesOnDisk();
      },
    });
    expect(journalAtSave).toEqual([expect.objectContaining({ ...DM, decisionId: expect.any(String) })]);
  });

  it('restart with the round still open on disk: the journalled rewrite is dropped, not sent', async () => {
    const g = pendingGoal();
    const round = g.capDecisionId as string;
    failNextUpdates = 10;
    answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: round,
      actor: 'U-owner',
      decision: 'cancel',
      surface: 'dashboard',
      save: () => {},
    });
    // The process died before the session save landed: on disk the round is still open.
    reloadGoalCapDmRewrites();
    failNextUpdates = 0;
    updates = [];
    expect(flushGoalCapDmSync((id) => id === round)).toBe(0);
    await flush();
    expect(updates).toEqual([]);
    expect(rewritesOnDisk()).toEqual([]);
  });

  it('restart with the round ended on disk: the rewrite is sent', async () => {
    const g = pendingGoal();
    failNextUpdates = 10;
    answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'cancel',
      surface: 'dashboard',
      save: () => {},
    });
    reloadGoalCapDmRewrites();
    failNextUpdates = 0;
    updates = [];
    expect(flushGoalCapDmSync(() => false)).toBe(1);
    await flush();
    expect(updates).toEqual([{ ref: DM, text: goalCapDecisionResolvedText('cancel', 'dashboard') }]);
  });

  it('a journal that cannot be written refuses the answer — nothing is decided, nothing resumes', () => {
    const g = pendingGoal();
    io.failJournalWrites = true;
    const save = vi.fn();
    const result = answerGoalCapDecision({
      session: session(g),
      sessionKey: KEY,
      goalId: 'goal-1',
      decisionId: g.capDecisionId,
      actor: 'U-owner',
      decision: 'continue',
      surface: 'dashboard',
      save,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(g.capDmPendingAt).toBe(1000);
    expect(g.continuationCount).toBe(10);
    expect(save).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(pendingGoalCapDmRewrites()).toEqual([]);
  });
});
