import { describe, expect, it, vi } from 'vitest';
import {
  askFollowUpQuestion,
  buildFollowUpQuestion,
  consumeFollowUpVerdict,
  FOLLOW_UP_ACTIONS,
  FOLLOW_UP_QUESTION_ID,
  type FollowUpQuestionDeps,
  shouldAskFollowUpQuestion,
  takeFollowUpQuestion,
} from '../follow-up-question';
import { applyFollowUp, setFollowUpListener } from '../summary-service';

/**
 * #917 — waiting on the user always comes with a question.
 *
 * SSOT_1 (Z, 2026-11-04): "유저에게 질문없이 "입력 대기:하는 경우가 있음 … 유저 입력대기는 반드시 최소한 질문
 * 하나에 해당 질문에 1번은 추천 행동 2번 3번은 대안행동 그리고 맨 마지막에는 직접입력하는 유저에게 질문이
 * 있어야함."
 *
 * A session the last Executive Summary left with a ⚠️ follow-up waits on its user. When nothing else will act or
 * ask — no open question, no turn, no goal eval or retry about to run — the host asks the follow-up question:
 * three next actions (1 recommended) and the host's direct input last.
 */

const REASON = 'PR #12 열림 — 머지에 메인테이너 승인이 필요';
const NOW = 1_793_779_000_000;

function idle(overrides: Record<string, any> = {}): any {
  return {
    channelId: 'C1',
    threadTs: 't1',
    activityState: 'idle',
    state: 'MAIN',
    followUp: { reason: REASON, at: NOW - 60_000 },
    actionPanel: {},
    ...overrides,
  };
}

describe('the follow-up question', () => {
  it('is one question: 3 next actions, choice 1 recommended, the reason in its description', () => {
    const q = buildFollowUpQuestion(REASON);
    expect(q.type).toBe('user_choices');
    expect(q.description).toContain(REASON);
    expect(q.questions).toHaveLength(1);
    const item = q.questions[0];
    expect(item.id).toBe(FOLLOW_UP_QUESTION_ID);
    expect(item.choices.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(item.choices.map((c) => c.label)).toEqual([...FOLLOW_UP_ACTIONS]);
    expect(item.recommendedChoiceId).toBe('1');
    // The host adds 직접 입력 itself (Slack form + dashboard form) — never a choice of its own.
    expect(item.choices.some((c) => /직접\s*입력/.test(c.label))).toBe(false);
  });
});

describe('shouldAskFollowUpQuestion', () => {
  const ok = (s: any, requestActive = false) => shouldAskFollowUpQuestion(s, { requestActive, now: NOW });

  it('asks an idle session with a follow-up and nothing open', () => {
    expect(ok(idle())).toBe(true);
  });

  it('not without a follow-up, or with an empty reason', () => {
    expect(ok(idle({ followUp: undefined }))).toBe(false);
    expect(ok(idle({ followUp: { reason: '  ', at: 1 } }))).toBe(false);
  });

  it('once per verdict: not again after it was asked', () => {
    expect(ok(idle({ followUp: { reason: REASON, at: 1, askedAt: NOW - 1 } }))).toBe(false);
  });

  it('not while a turn runs or the session is not idle', () => {
    expect(ok(idle(), true)).toBe(false);
    expect(ok(idle({ activityState: 'working' }))).toBe(false);
    expect(ok(idle({ activityState: 'waiting' }))).toBe(false);
  });

  it('not while a question is already open (never two at once)', () => {
    expect(ok(idle({ actionPanel: { pendingQuestion: { type: 'user_choice' } } }))).toBe(false);
    expect(ok(idle({ actionPanel: { pendingChoice: { kind: 'single' } } }))).toBe(false);
    expect(ok(idle({ actionPanel: { waitingForChoice: true } }))).toBe(false);
  });

  it('not while a plan waits for its start (that is its question)', () => {
    expect(ok(idle({ taskPlan: { state: 'awaiting' } }))).toBe(false);
  });

  it('not while the agent is about to act again: goal eval, eval backoff, error retry', () => {
    const goal = { status: 'active', goalId: 'g1' };
    expect(ok(idle({ goal: { ...goal, pendingEval: { requestedAt: NOW } } }))).toBe(false);
    expect(ok(idle({ goal: { ...goal, evalBackoffUntil: NOW + 1000 } }))).toBe(false);
    expect(ok(idle({ sessionId: 's1', pendingRetryAt: NOW + 1000, pendingRetrySessionId: 's1' }))).toBe(false);
    // the goal loop's own questions
    expect(ok(idle({ goal: { ...goal, stall: { stallId: 'x' } } }))).toBe(false);
    expect(ok(idle({ goal: { ...goal, capDecisionId: 'd1', capDmPendingAt: NOW } }))).toBe(false);
    // an active goal whose loop is not about to act: asked
    expect(ok(idle({ goal }))).toBe(true);
  });

  it('not on a sleeping or terminated session', () => {
    expect(ok(idle({ state: 'SLEEPING' }))).toBe(false);
    expect(ok(idle({ terminated: true }))).toBe(false);
  });
});

describe('askFollowUpQuestion', () => {
  function deps(session: any, over: Partial<FollowUpQuestionDeps> = {}): FollowUpQuestionDeps {
    return {
      getSession: () => session,
      isRequestActive: () => false,
      ask: vi.fn(async () => 'host:k:1'),
      retract: vi.fn(async () => undefined),
      save: vi.fn(),
      now: () => NOW,
      ...over,
    };
  }

  it('asks through the host question surface and binds the question to the follow-up', async () => {
    const s = idle();
    const d = deps(s);
    await askFollowUpQuestion('k', d);
    expect(d.ask).toHaveBeenCalledTimes(1);
    const [key, question] = (d.ask as any).mock.calls[0];
    expect(key).toBe('k');
    expect(question.questions[0].id).toBe(FOLLOW_UP_QUESTION_ID);
    expect(s.followUp).toMatchObject({ reason: REASON, askedAt: NOW, questionTurnId: 'host:k:1' });
    expect(d.save).toHaveBeenCalled();
  });

  it('marks the verdict asked before the post, so a second trigger meanwhile does not ask twice', async () => {
    const s = idle();
    let release!: (v: string) => void;
    const d = deps(s, { ask: vi.fn(() => new Promise<string>((r) => (release = r))) });
    const first = askFollowUpQuestion('k', d);
    await askFollowUpQuestion('k', d);
    expect(d.ask).toHaveBeenCalledTimes(1);
    release('host:k:2');
    await first;
    expect(s.followUp.questionTurnId).toBe('host:k:2');
  });

  it('nothing to ask → no post', async () => {
    const d = deps(idle({ followUp: undefined }));
    await askFollowUpQuestion('k', d);
    expect(d.ask).not.toHaveBeenCalled();
  });

  it('the post left nothing open (the user moved on) → the verdict may be asked again later', async () => {
    const s = idle();
    const d = deps(s, { ask: vi.fn(async () => undefined) });
    await askFollowUpQuestion('k', d);
    expect(s.followUp.askedAt).toBeUndefined();
  });

  it('the commit check refuses when a goal eval or a turn started during the post (trinity R1 grok P1)', async () => {
    for (const change of [
      (s: any) => {
        s.goal = { status: 'active', pendingEval: { requestedAt: NOW } };
      },
      (s: any) => {
        s.activityState = 'working';
      },
    ]) {
      const s = idle();
      let wanted: boolean | undefined;
      const d = deps(s, {
        ask: vi.fn(async (_k: string, _q: unknown, opts: { stillWanted: () => boolean }) => {
          change(s);
          wanted = opts.stillWanted();
          return undefined;
        }),
      });
      await askFollowUpQuestion('k', d);
      expect(wanted).toBe(false);
      expect(s.followUp.askedAt).toBeUndefined();
    }
  });

  it('the follow-up changed while the question was posted → the question is retracted', async () => {
    const s = idle();
    const d = deps(s, {
      ask: vi.fn(async () => {
        s.followUp = { reason: 'another reason', at: NOW };
        return 'host:k:3';
      }),
    });
    await askFollowUpQuestion('k', d);
    expect(d.retract).toHaveBeenCalledWith('k', 'host:k:3');
  });
});

describe('applyFollowUp — each verdict may ask once (#917)', () => {
  const WARN = (reason: string) => ['done', `⚠️ **${reason}**`, 'next'];

  it('the same reason again is a new verdict: it keeps its time and its question binding, and may be asked again', () => {
    const s: any = { followUp: { reason: REASON, at: 1000, askedAt: 2000, questionTurnId: 'host:k:1' } };
    applyFollowUp(s, WARN(REASON), 9000);
    // askedAt goes (the next stop asks again); questionTurnId stays, so a later clear still retracts that question.
    expect(s.followUp).toEqual({ reason: REASON, at: 1000, questionTurnId: 'host:k:1' });
  });

  it('tells the host listener what it was and what it is now', () => {
    const heard: any[] = [];
    setFollowUpListener((session, previous) => heard.push({ now: session.followUp, previous }));
    try {
      const s: any = { followUp: { reason: REASON, at: 1000, questionTurnId: 'host:k:1' } };
      applyFollowUp(s, ['all merged', 'nothing left', 'done'], 9000);
      expect(heard).toEqual([{ now: undefined, previous: { reason: REASON, at: 1000, questionTurnId: 'host:k:1' } }]);
    } finally {
      setFollowUpListener(undefined);
    }
  });
});

describe('consumeFollowUpVerdict — the user acting consumes the verdict (trinity R1 fable P2)', () => {
  it('marks an unasked verdict asked, so the turn that answered the model question does not end in a second ask', () => {
    const s = idle();
    consumeFollowUpVerdict(s, NOW);
    expect(s.followUp.askedAt).toBe(NOW);
    expect(shouldAskFollowUpQuestion(s, { requestActive: false, now: NOW })).toBe(false);
  });

  it('keeps an asked verdict as it was, and does nothing without a follow-up', () => {
    const s = idle({ followUp: { reason: REASON, at: 1, askedAt: 5 } });
    consumeFollowUpVerdict(s, NOW);
    expect(s.followUp.askedAt).toBe(5);
    const none = idle({ followUp: undefined });
    consumeFollowUpVerdict(none, NOW);
    expect(none.followUp).toBeUndefined();
  });

  it('the next summary verdict re-opens it (applyFollowUp drops askedAt)', () => {
    const s: any = idle();
    consumeFollowUpVerdict(s, NOW);
    applyFollowUp(s, ['done', `⚠️ **${REASON}**`, 'next'], NOW + 1);
    expect(shouldAskFollowUpQuestion(s, { requestActive: false, now: NOW + 2 })).toBe(true);
  });
});

describe('takeFollowUpQuestion — a goal kick takes the question back (trinity R2 fable P2)', () => {
  it('returns the asked question to retract, unbinds it and consumes the verdict', () => {
    const s = idle({ followUp: { reason: REASON, at: 1, askedAt: 2, questionTurnId: 'host:k:9' } });
    expect(takeFollowUpQuestion(s, NOW)).toBe('host:k:9');
    expect(s.followUp.questionTurnId).toBeUndefined();
    expect(s.followUp.askedAt).toBe(2);
  });

  it('an unasked verdict is consumed (the agent acts again; the next summary judges), nothing to retract', () => {
    const s = idle();
    expect(takeFollowUpQuestion(s, NOW)).toBeUndefined();
    expect(s.followUp.askedAt).toBe(NOW);
    expect(takeFollowUpQuestion(idle({ followUp: undefined }), NOW)).toBeUndefined();
  });
});
