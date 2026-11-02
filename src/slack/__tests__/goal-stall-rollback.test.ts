/**
 * Goal stall → roll back to the first failure (#745). Requested 2026-11-02:
 * "이러한 경우에 goal이 실패할경우 아무것도 하지 않았을 경우 처음 goal이 실패한 지점으로
 * 롤백 (유저에게 위에 질문에 이어서 같이 물어봐줘 해당 지점으로 롤백할 것인지)".
 *
 * The loop records where the goal first failed for the current reason (the
 * context anchor at the end of that turn) and whether any turn since did new
 * work. When it stalls and nothing was done since, the stall question asks a
 * second item: roll the context back to that point. Answering yes rolls the
 * context back before the answer turn runs.
 */

import { encodeContextAnchor } from '@soma/slack/context-anchor';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession, SessionGoal } from '../../types';
import type { GoalEvalVerdict } from '../goal-completion-evaluator';
import { GoalLoopController, type GoalStallQuestion } from '../goal-loop-controller';
import {
  applyGoalStallRollbackAnswer,
  buildGoalStallQuestion,
  GOAL_STALL_ROLLBACK_QUESTION_ID,
  goalStallRollbackChosen,
  goalStallRollbackNotice,
} from '../goal-stall';

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const A = (n: number) =>
  encodeContextAnchor({ sid: SID, epoch: 0, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
const KEY = 'C1:T1';

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'g1',
    objective: 'ship',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 0,
    ...overrides,
  };
}

function harness(goal: SessionGoal, verdicts: GoalEvalVerdict[], anchors: string[]) {
  const session = {
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: 'T1',
    sessionId: SID,
    compactionCount: 0,
    model: 'm',
    goal,
    goalLastTurnText: 'turn 0',
    contextAnchor: anchors[0],
  } as unknown as ConversationSession;
  const questions: GoalStallQuestion[] = [];
  const notices: string[] = [];
  let i = 0;
  const controller = new GoalLoopController({
    registry: { getSessionByKey: () => session, getActivityStateByKey: () => 'idle', saveSessions: () => undefined },
    requestCoordinator: { isRequestActive: () => false },
    dispatcher: async () => JSON.stringify(verdicts[Math.min(i++, verdicts.length - 1)]),
    injectContinuation: async () => undefined,
    postNotice: async (_channel: string, _threadTs: string | undefined, text: string) => {
      notices.push(text);
    },
    askStallQuestion: async (q) => {
      questions.push(q);
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'm',
  });
  // One settle per verdict: each "turn" ends at the next anchor with new text.
  const settle = async (n: number) => {
    (session as any).contextAnchor = anchors[n];
    (session as any).goalLastTurnText = `turn ${n}`;
    controller.onTurnSettled(KEY);
    await controller.settled(KEY);
  };
  return { controller, session, goal, questions, notices, settle };
}

const fail = (o: Partial<GoalEvalVerdict> = {}): GoalEvalVerdict => ({
  completed: false,
  reason: 'dev has 0 epics',
  remaining: ['run one epic'],
  ...o,
});

describe('the first failure point', () => {
  it('is the end of the turn where the current reason first appeared; a new reason moves it', async () => {
    const h = harness(
      makeGoal(),
      [
        fail(), // first failure — no previous
        fail({ sameAsPrevious: true, sameConfidence: 0.8, progressed: false }),
        fail({ reason: 'tests fail', sameAsPrevious: false, sameConfidence: 0.9, progressed: true }),
      ],
      [A(1), A(1), A(2), A(3)],
    );
    await h.settle(0);
    expect(h.goal.firstFailure?.anchor).toBe(A(1));
    await h.settle(2);
    expect(h.goal.firstFailure?.anchor).toBe(A(1));
    await h.settle(3);
    expect(h.goal.firstFailure?.anchor).toBe(A(3));
  });
});

describe('the stall question offers the rollback only when nothing was done', () => {
  it('no progress since the first failure → the question carries the rollback item', async () => {
    const h = harness(
      makeGoal(),
      [fail(), fail({ sameAsPrevious: true, sameConfidence: 0.97, progressed: false, userActions: ['a', 'b', 'c'] })],
      [A(1), A(1), A(2)],
    );
    await h.settle(0);
    await h.settle(2);
    expect(h.goal.stall?.rollbackAnchor).toBe(A(1));
    expect(h.questions[0].rollback).toEqual({ turns: 1 });
    expect(h.goal.stall?.rollbackKeptUntil).toBe(h.goal.firstFailure?.at);
    // The notice offers it too: it stands in when the question cannot be posted.
    expect(h.notices[h.notices.length - 1]).toContain('`rollback goal`');
    const q = buildGoalStallQuestion(h.questions[0]);
    const item = q.questions.find((x) => x.id === GOAL_STALL_ROLLBACK_QUESTION_ID);
    expect(item?.choices.map((c) => c.id)).toEqual(['yes', 'no']);
  });

  it('a turn that did new work since → no rollback item', async () => {
    const h = harness(
      makeGoal(),
      [
        fail(),
        fail({ sameAsPrevious: true, sameConfidence: 0.8, progressed: true }),
        fail({ sameAsPrevious: true, sameConfidence: 0.99, progressed: false }),
      ],
      [A(1), A(1), A(2), A(3)],
    );
    await h.settle(0);
    await h.settle(2);
    await h.settle(3);
    expect(h.goal.stall).toBeDefined();
    expect(h.goal.stall?.rollbackAnchor).toBeUndefined();
    expect(buildGoalStallQuestion(h.questions[0]).questions).toHaveLength(1);
    expect(h.notices[h.notices.length - 1]).not.toContain('rollback goal');
  });

  it('the first failure is the current tail (nothing to drop) → no rollback item', async () => {
    const h = harness(
      makeGoal(),
      [fail(), fail({ sameAsPrevious: true, sameConfidence: 0.99, progressed: false })],
      [A(1), A(1), A(1)],
    );
    await h.settle(0);
    await h.settle(2);
    expect(h.goal.stall?.rollbackAnchor).toBeUndefined();
  });
});

describe('answering the question', () => {
  const answerYes =
    'Goal을 끝내기 위한 다음 지시: 1. epicTasks 켰어\n처음 실패한 지점으로 문맥 되돌리기: yes. 예 — 되돌리고 진행';

  it('reads yes / no from the answer text', () => {
    expect(goalStallRollbackChosen(answerYes)).toBe(true);
    expect(goalStallRollbackChosen('처음 실패한 지점으로 문맥 되돌리기: no. 아니오')).toBe(false);
    expect(goalStallRollbackChosen('just a message')).toBe(false);
  });

  it('yes → a rollback to the first failure waits for this very turn', () => {
    const session = {
      ownerId: 'U1',
      sessionId: SID,
      compactionCount: 0,
      contextAnchor: A(2),
      goal: makeGoal({
        stall: {
          stallId: 's1',
          stalledAt: 1,
          reason: 'r',
          actions: ['a', 'b', 'c'],
          confidence: 0.99,
          rollbackAnchor: A(1),
          rollbackKeptUntil: 40,
        },
        firstFailure: { anchor: A(1), at: 40, turns: 2, progressed: false },
      }),
    } as unknown as ConversationSession;
    const applied = applyGoalStallRollbackAnswer(session, answerYes, 'U1', { transcriptHas: () => true });
    expect(applied?.ok).toBe(true);
    // What came after the first failure's turn is what the dashboard marks as dropped (#744).
    expect(session.pendingRewind).toMatchObject({ anchor: A(1), source: 'goal', requestedBy: 'U1', keptUntil: 40 });
  });

  it('the span it drops is fixed when the offer is made — a rollback in between does not lose it', () => {
    const session = {
      ownerId: 'U1',
      sessionId: SID,
      compactionCount: 0,
      contextAnchor: A(2),
      goal: makeGoal({
        stall: {
          stallId: 's1',
          stalledAt: 1,
          reason: 'r',
          actions: ['a'],
          confidence: 0.99,
          rollbackAnchor: A(1),
          rollbackKeptUntil: 40,
        },
        // Another rollback was applied meanwhile: firstFailure is gone.
        firstFailure: undefined,
      }),
    } as unknown as ConversationSession;
    expect(applyGoalStallRollbackAnswer(session, answerYes, 'U1', { transcriptHas: () => true })?.ok).toBe(true);
    expect(session.pendingRewind?.keptUntil).toBe(40);
  });

  it('no answer for the rollback item or no offer → nothing; another user → refused, and it says so', () => {
    const base = () =>
      ({
        ownerId: 'U1',
        sessionId: SID,
        compactionCount: 0,
        contextAnchor: A(2),
        goal: makeGoal({
          stall: { stallId: 's1', stalledAt: 1, reason: 'r', actions: ['a'], confidence: 0.99, rollbackAnchor: A(1) },
        }),
      }) as unknown as ConversationSession;
    const s1 = base();
    expect(applyGoalStallRollbackAnswer(s1, 'ok go', 'U1', { transcriptHas: () => true })).toBeUndefined();
    const s2 = base();
    const refused = applyGoalStallRollbackAnswer(s2, answerYes, 'U2', { transcriptHas: () => true });
    expect(refused).toEqual({ ok: false, reason: 'not-owner' });
    const s3 = base();
    (s3.goal as any).stall.rollbackAnchor = undefined;
    expect(applyGoalStallRollbackAnswer(s3, answerYes, 'U1', { transcriptHas: () => true })).toBeUndefined();
    expect(s1.pendingRewind ?? s2.pendingRewind ?? s3.pendingRewind).toBeUndefined();
  });

  it('the thread is told either way: rolled back, or why not and that the turn runs as it is', () => {
    expect(goalStallRollbackNotice({ ok: true } as any)).toContain('처음 실패한 지점으로');
    const no = goalStallRollbackNotice({ ok: false, reason: 'compacted' });
    expect(no).toContain('⛔');
    expect(no).toContain('/compact');
    expect(no).toContain('지금 문맥 그대로');
  });
});
