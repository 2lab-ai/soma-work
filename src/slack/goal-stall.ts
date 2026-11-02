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
import type { UserChoices } from '@soma/slack/user-choice-extractor';
import type { SessionGoal, SessionGoalStall } from '../types';
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
export function openGoalStall(goal: SessionGoal, verdict: GoalEvalVerdict, now: number): SessionGoalStall {
  const stall: SessionGoalStall = {
    stallId: randomUUID(),
    stalledAt: now,
    reason: verdict.reason,
    actions: stallActionsOf(verdict),
    confidence: verdict.sameConfidence ?? 0,
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
export function buildGoalStallQuestion(input: { reason: string; actions: string[] }): UserChoices {
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
    ],
  };
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
