/**
 * #917 — waiting on the user always comes with a question.
 *
 * SSOT (Z, 2026-11-04): "유저 입력대기는 반드시 최소한 질문 하나에 해당 질문에 1번은 추천 행동 2번 3번은 대안행동
 * 그리고 맨 마지막에는 직접입력하는 유저에게 질문이 있어야함."
 *
 * The last Executive Summary left a ⚠️ follow-up (`session.followUp`): the agent stopped with its own work
 * unfinished. The dashboard no longer shows that as 입력 대기 by itself. When nothing else will act or ask — no
 * open question, no turn, no goal eval or retry about to run — the host asks this question, through the same surface
 * as a model's ASK_USER_QUESTION (the thread form and the dashboard card, answered as a real user turn): three next
 * actions, choice 1 recommended, and the host's ✏️ 직접 입력 last. Once per verdict: `followUp.askedAt`.
 *
 * Leaf module: the question, the guard and the ask. The host wires the triggers (`SlackHandler`).
 */

import type { UserChoices } from '@soma/slack/user-choice-extractor';

/** Id of the follow-up question's one item in the multi-choice form. */
export const FOLLOW_UP_QUESTION_ID = 'follow-up-next';

/** The question's text — the answer reaches the model as `<question>: <id>. <label>`. */
export const FOLLOW_UP_QUESTION = '멈춘 작업을 어떻게 할까요';

/**
 * The three next actions: 1 the recommended one (finish it), 2 and 3 the alternatives. Generic on purpose — each is
 * something the owner can always say about an unfinished artifact; the reason itself is in the description.
 */
export const FOLLOW_UP_ACTIONS: readonly string[] = [
  '막힌 부분을 직접 해결해서 끝까지 진행해',
  '막힌 부분은 건너뛰고 남은 작업부터 진행해',
  '여기서 마무리하고 남은 일과 할 사람을 정리해 보고해',
];

/**
 * The question the host posts. A multi-choice form (one item) so the answer carries its label — the model never
 * saw this question, and a bare choice id would mean nothing to it (the goal-stall question does the same).
 */
export function buildFollowUpQuestion(reason: string): UserChoices {
  return {
    type: 'user_choices',
    title: '⚠️ 후속 작업 필요 — 다음에 할 일을 골라 주세요',
    description: `작업이 끝나지 않은 채 멈췄습니다.\n이유: ${reason}`,
    questions: [
      {
        id: FOLLOW_UP_QUESTION_ID,
        question: FOLLOW_UP_QUESTION,
        choices: FOLLOW_UP_ACTIONS.map((label, i) => ({ id: String(i + 1), label })),
        recommendedChoiceId: '1',
      },
    ],
  };
}

/** The session fields the guard reads (a `ConversationSession`, or a test double). */
export interface FollowUpQuestionSession {
  sessionId?: string;
  activityState?: string;
  state?: string;
  terminated?: boolean;
  followUp?: { reason?: string; at?: number; askedAt?: number; questionTurnId?: string };
  actionPanel?: { pendingQuestion?: unknown; pendingChoice?: unknown; waitingForChoice?: boolean };
  taskPlan?: { state?: string };
  goal?: {
    status?: string;
    pendingEval?: unknown;
    evalBackoffUntil?: number;
    stall?: unknown;
    capDecisionId?: string;
    capDmPendingAt?: number;
  };
  pendingRetryAt?: number;
  pendingRetrySessionId?: string;
}

/**
 * Ask now? Only for a follow-up not yet asked for this verdict, on an idle session with nothing else asking (an open
 * question, a plan awaiting its start, the goal's stall or cap question) and nothing about to act (a turn, a goal
 * eval or its backoff, an armed error retry).
 */
export function shouldAskFollowUpQuestion(
  session: FollowUpQuestionSession | undefined,
  input: { requestActive: boolean; now: number },
): boolean {
  const f = session?.followUp;
  if (!session || !f || typeof f.reason !== 'string' || !f.reason.trim()) return false;
  if (f.askedAt !== undefined) return false;
  const panel = session.actionPanel;
  if (panel?.pendingQuestion || panel?.pendingChoice || panel?.waitingForChoice === true) return false;
  return !somethingElseActsOrAsks(session, input);
}

/**
 * The session is not idle, a turn runs, or something else is about to act or ask: a plan awaiting its start, the
 * goal's eval, backoff, stall or cap question, an armed error retry. Checked before the ask and again when the
 * posted question is committed (the post takes a moment; a goal eval or a continuation may start meanwhile).
 */
export function somethingElseActsOrAsks(
  session: FollowUpQuestionSession,
  input: { requestActive: boolean; now: number },
): boolean {
  if (session.terminated === true || session.state === 'SLEEPING') return true;
  if (input.requestActive || (session.activityState || 'idle') !== 'idle') return true;
  if (session.taskPlan?.state === 'awaiting') return true;
  const goal = session.goal;
  if (goal?.status === 'active') {
    if (goal.pendingEval || goal.stall) return true;
    if (typeof goal.evalBackoffUntil === 'number' && goal.evalBackoffUntil > input.now) return true;
    if (typeof goal.capDecisionId === 'string' && goal.capDecisionId && goal.capDmPendingAt !== undefined) return true;
  }
  const retryAt = Number(session.pendingRetryAt);
  return (
    Number.isFinite(retryAt) &&
    retryAt > input.now &&
    session.pendingRetrySessionId !== undefined &&
    session.pendingRetrySessionId === session.sessionId
  );
}

/**
 * The user's own word consumes the verdict (trinity R1 fable P2): they act on the session now, so the follow-up the
 * last summary left is not asked again after this turn — it is the next summary's to judge. Without this, a turn
 * that answered the model's own question ended, and the host asked about the old ⚠️ reason at once.
 */
export function consumeFollowUpVerdict(session: object | undefined, now: number): void {
  const f = (session as { followUp?: { askedAt?: number } } | undefined)?.followUp;
  if (f && f.askedAt === undefined) f.askedAt = now;
}

/**
 * The host is about to let the agent act again on its own (a goal resume, an objective update): the follow-up question
 * no longer applies (trinity R2 fable P2 — left open, the session stays `waiting` and the kicked loop refuses to run).
 * Consumes the verdict and returns the question's turn id to retract, if one was asked.
 */
export function takeFollowUpQuestion(session: object | undefined, now: number): string | undefined {
  const f = (session as { followUp?: { askedAt?: number; questionTurnId?: string } } | undefined)?.followUp;
  if (!f) return undefined;
  consumeFollowUpVerdict(session, now);
  const turnId = f.questionTurnId;
  f.questionTurnId = undefined;
  return turnId;
}

export interface FollowUpQuestionDeps {
  getSession(sessionKey: string): FollowUpQuestionSession | undefined;
  isRequestActive(sessionKey: string): boolean;
  /** The host question surface (`StreamExecutor.askUserQuestionFromHost`): the question's turn id, or undefined. */
  ask(sessionKey: string, question: UserChoices, opts: { stillWanted: () => boolean }): Promise<string | undefined>;
  retract(sessionKey: string, turnId: string): Promise<void>;
  save(): void;
  now(): number;
}

/**
 * Ask the follow-up question when {@link shouldAskFollowUpQuestion} says so. The verdict is marked asked before the
 * post, so a second trigger meanwhile does not ask twice; a post that left nothing open (the user moved on, Slack
 * failed) unmarks it. A follow-up that changed while the question was posted takes the question back.
 */
export async function askFollowUpQuestion(sessionKey: string, deps: FollowUpQuestionDeps): Promise<void> {
  const session = deps.getSession(sessionKey);
  if (!shouldAskFollowUpQuestion(session, { requestActive: deps.isRequestActive(sessionKey), now: deps.now() })) {
    return;
  }
  const followUp = session!.followUp!;
  const reason = String(followUp.reason).trim();
  followUp.askedAt = deps.now();
  const sameVerdict = () => deps.getSession(sessionKey)?.followUp === followUp;
  // Re-checked when the posted question is committed: the post takes a moment, and a turn, a goal eval or a
  // continuation that started meanwhile must not find a question opened beside it.
  const stillWanted = () => {
    const live = deps.getSession(sessionKey);
    return (
      !!live &&
      live.followUp === followUp &&
      !somethingElseActsOrAsks(live, { requestActive: deps.isRequestActive(sessionKey), now: deps.now() })
    );
  };
  const turnId = await deps.ask(sessionKey, buildFollowUpQuestion(reason), { stillWanted });
  if (!turnId) {
    if (sameVerdict()) followUp.askedAt = undefined;
    return;
  }
  if (!sameVerdict()) {
    await deps.retract(sessionKey, turnId);
    return;
  }
  followUp.questionTurnId = turnId;
  deps.save();
}
