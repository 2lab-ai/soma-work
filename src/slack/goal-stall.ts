/**
 * Goal stall — the evaluator judged the goal failed again for the same reason
 * (≥ GOAL_STALL_MIN_CONFIDENCE). The loop stops and the owner is asked which
 * of three next instructions to give. See docs/goal-command/spec.md
 * §Stall: same failure twice.
 *
 * Leaf module: state helpers only. The controller opens the stall, the
 * question surface is wired by the host, and every path that ends a goal's
 * open owner decision (`retireGoalCapDecision`) ends the stall too.
 */

import { randomUUID } from 'node:crypto';
import { anchorRefusal } from '@soma/slack/context-anchor';
import type { UserChoices } from '@soma/slack/user-choice-extractor';
import {
  CONTEXT_ROLLBACK_REFUSAL_TEXT,
  type ContextRollbackResult,
  requestContextRollback,
} from '../session/context-rollback';
import type { ConversationSession, SessionGoal, SessionGoalStall } from '../types';
import type { GoalEvalVerdict } from './goal-completion-evaluator';

/**
 * Confidence at or above which "failed again for the same reason" stops the
 * loop and asks the owner (requested 2026-11-02, "0.95이상의 확신일 경우").
 */
export const GOAL_STALL_MIN_CONFIDENCE = 0.95;

/** How many next-step options the stall question offers. */
export const GOAL_STALL_ACTION_COUNT = 3;

/**
 * Used when the evaluator returned fewer than three actions. Generic on
 * purpose: each is something the owner can always say.
 */
export const GOAL_STALL_FALLBACK_ACTIONS: readonly string[] = [
  '막힌 부분은 다른 방법으로 우회해서 계속 진행해',
  '남은 항목은 빼고 지금까지 된 것으로 마무리해',
  '여기까지 한 것과 남은 것을 정리해서 보고해',
];

/** Three distinct actions: the evaluator's first, then the fallbacks. */
export function stallActionsOf(verdict: GoalEvalVerdict): string[] {
  const out: string[] = [];
  for (const a of [...(verdict.userActions ?? []), ...GOAL_STALL_FALLBACK_ACTIONS]) {
    if (out.length >= GOAL_STALL_ACTION_COUNT) break;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** Open a stall round on the goal. Mutates the goal only; the caller persists. */
export function openGoalStall(
  goal: SessionGoal,
  verdict: GoalEvalVerdict,
  now: number,
  rollback?: { anchor: string; turns: number },
): SessionGoalStall {
  const stall: SessionGoalStall = {
    stallId: randomUUID(),
    stalledAt: now,
    reason: verdict.reason,
    actions: stallActionsOf(verdict),
    confidence: verdict.sameConfidence ?? 0,
    ...(rollback ? { rollbackAnchor: rollback.anchor, rollbackTurns: rollback.turns } : {}),
  };
  goal.stall = stall;
  goal.updatedAt = now;
  return stall;
}

/**
 * Why a stall round ended. `user-message`: the owner wrote (the answer to the
 * question, or anything typed) — that turn clears the question itself.
 * `lifecycle`: pause, done, delete, resume, update, a goal added — the open
 * question no longer applies and is retracted.
 */
export type GoalStallRetireCause = 'user-message' | 'lifecycle';

type StallRetiredListener = (goal: SessionGoal, stall: SessionGoalStall, cause: GoalStallRetireCause) => void;
let onRetired: StallRetiredListener | undefined;

/** Host hook: a stall round ended. Production: retract its question when it ended without an answer. */
export function setGoalStallRetiredListener(fn: StallRetiredListener | undefined): void {
  onRetired = fn;
}

/**
 * End the goal's open stall round. Called by every real user message and by
 * every goal lifecycle change (through `retireGoalCapDecision`).
 */
export function retireGoalStall(goal: SessionGoal | undefined, cause: GoalStallRetireCause = 'lifecycle'): void {
  const stall = goal?.stall;
  if (!goal || !stall) return;
  goal.stall = undefined;
  try {
    onRetired?.(goal, stall, cause);
  } catch {
    // A surface update must never break the goal mutation that ended the round.
  }
}

/** Id of the stall question's "next action" item in the multi-choice form. */
export const GOAL_STALL_NEXT_QUESTION_ID = 'goal-stall-next';

/**
 * The question the host posts on a stall. A multi-choice form (even with one
 * item) so the answer reaches the model as "<question>: <id>. <label>" — a
 * bare choice id would mean nothing to a model that never saw the question.
 */
export function buildGoalStallQuestion(input: {
  reason: string;
  actions: string[];
  rollback?: { turns: number };
}): UserChoices {
  return {
    type: 'user_choices',
    title: '🛑 Goal 멈춤 — 다음에 할 일을 골라 주세요',
    description: `같은 이유로 다시 실패해서 자동 진행을 멈췄습니다.\n이유: ${input.reason}`,
    questions: [
      {
        id: GOAL_STALL_NEXT_QUESTION_ID,
        question: 'Goal을 끝내기 위한 다음 지시',
        choices: input.actions.map((label, i) => ({ id: String(i + 1), label })),
        recommendedChoiceId: '1',
      },
      ...(input.rollback
        ? [
            {
              id: GOAL_STALL_ROLLBACK_QUESTION_ID,
              question: GOAL_STALL_ROLLBACK_QUESTION,
              context: `처음 실패한 뒤 ${input.rollback.turns}턴은 진전이 없었습니다. 되돌리면 그 턴들이 모델 문맥에서 빠집니다 (파일은 그대로).`,
              choices: [
                { id: 'yes', label: '예 — 처음 실패한 지점으로 되돌리고 진행' },
                { id: 'no', label: '아니오 — 지금 문맥 그대로 진행' },
              ],
              recommendedChoiceId: 'yes',
            },
          ]
        : []),
    ],
  };
}

/** #745: the stall question's second item — roll the context back to the first failure. */
export const GOAL_STALL_ROLLBACK_QUESTION_ID = 'goal-stall-rollback';
export const GOAL_STALL_ROLLBACK_QUESTION = '처음 실패한 지점으로 문맥 되돌리기';

/**
 * Did the answer pick "yes" on the rollback item? The multi-choice answer
 * reaches the host as lines `<question>: <choiceId>. <label>`
 * (`ChoiceActionHandler`, Slack form and dashboard alike).
 */
export function goalStallRollbackChosen(text: string): boolean {
  return text.split('\n').some((line) => line.trim().startsWith(`${GOAL_STALL_ROLLBACK_QUESTION}: yes.`));
}

/** The label a rollback to the stall's first failure carries (notices, the dashboard). */
export const GOAL_STALL_ROLLBACK_LABEL = '처음 실패한 지점 (goal 멈춤)';

/**
 * #745: ask for a rollback to where the stalled goal first failed for its
 * current reason, through the one gate. Undefined when the stall offers none
 * (no stall, or the repeated turns did work).
 */
export function requestGoalStallRollback(
  session: ConversationSession,
  actor: string,
  deps: { requestActive: boolean; transcriptHas?: (sessionId: string, uuid: string) => boolean },
): ContextRollbackResult | undefined {
  const anchor = session.goal?.stall?.rollbackAnchor;
  if (!anchor) return undefined;
  return requestContextRollback(session, { anchor, label: GOAL_STALL_ROLLBACK_LABEL, source: 'goal' }, actor, deps);
}

/**
 * #745: the stall question was answered with "yes" on the rollback item — the
 * context rolls back to the first failure before this very turn runs (the
 * caller is the turn's own pre-dispatch, so no other turn holds the slot).
 * Undefined when the answer did not pick it or there is no offer; otherwise
 * the gate's result — a refusal is the caller's to tell (never silent).
 */
export function applyGoalStallRollbackAnswer(
  session: ConversationSession,
  text: string,
  actor: string,
  deps: { transcriptHas?: (sessionId: string, uuid: string) => boolean } = {},
): ContextRollbackResult | undefined {
  if (!goalStallRollbackChosen(text)) return undefined;
  return requestGoalStallRollback(session, actor, { requestActive: false, transcriptHas: deps.transcriptHas });
}

/** What the thread is told about the answer's rollback: done, or why not (the turn runs as it is). */
export function goalStallRollbackNotice(result: ContextRollbackResult): string {
  return result.ok
    ? '⏪ 처음 실패한 지점으로 모델 문맥을 되돌리고 이 지시를 진행합니다 (파일 변경은 그대로).'
    : `⛔ 처음 실패한 지점으로 되돌리지 못했습니다 — ${CONTEXT_ROLLBACK_REFUSAL_TEXT[result.reason]} 이 지시는 지금 문맥 그대로 진행합니다.`;
}

/**
 * Ask only for the stall round that is still open, while no turn runs and no
 * other question is open — a model's question is never superseded.
 */
export function shouldAskGoalStallQuestion(
  session:
    | {
        goal?: SessionGoal;
        actionPanel?: { pendingQuestion?: unknown; waitingForChoice?: boolean };
      }
    | undefined,
  input: { goalId: string; stallId: string },
  requestActive: boolean,
): boolean {
  if (!session?.goal || session.goal.goalId !== input.goalId) return false;
  if (session.goal.stall?.stallId !== input.stallId) return false;
  if (requestActive) return false;
  return !session.actionPanel?.pendingQuestion && !session.actionPanel?.waitingForChoice;
}

/**
 * #745: remember where the goal first failed for its current reason — the
 * context anchor at the end of the turn just judged — and whether any turn
 * since did new work. A new reason starts it over; completion drops it.
 * Called with every real verdict, before `decideGoalEvalOutcome` overwrites
 * `lastEvalReason`.
 */
export function trackGoalFirstFailure(
  session: Pick<ConversationSession, 'contextAnchor'>,
  goal: SessionGoal,
  verdict: GoalEvalVerdict,
  now: number,
): void {
  if (verdict.completed) {
    goal.firstFailure = undefined;
    return;
  }
  const sameReason = !!goal.lastEvalReason?.trim() && verdict.sameAsPrevious === true && !!goal.firstFailure;
  if (!sameReason) {
    goal.firstFailure = { anchor: session.contextAnchor, at: now, turns: 0, progressed: false };
    return;
  }
  const first = goal.firstFailure as NonNullable<SessionGoal['firstFailure']>;
  first.turns += 1;
  if (verdict.progressed === true) first.progressed = true;
}

/**
 * #745: offer the rollback with the stall when no turn since the first failure
 * did new work and there is something to drop (the first failure is not the
 * current tail, and its anchor is still usable in this context).
 */
export function goalStallRollbackOffer(
  session: Pick<ConversationSession, 'contextAnchor' | 'sessionId' | 'compactionCount'>,
  goal: SessionGoal,
  verdict: GoalEvalVerdict,
): { anchor: string; turns: number } | undefined {
  const first = goal.firstFailure;
  if (!first?.anchor || first.progressed || verdict.progressed === true) return undefined;
  if (first.anchor === session.contextAnchor || first.turns < 1) return undefined;
  if (anchorRefusal(session, first.anchor)) return undefined;
  return { anchor: first.anchor, turns: first.turns };
}
