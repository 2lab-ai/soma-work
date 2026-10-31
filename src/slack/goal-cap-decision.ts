/**
 * The goal's cap decision — "Goal 계속 진행할까요?" — as ONE request with two
 * answer surfaces: the owner's Slack DM (Continue / Cancel buttons) and the
 * dashboard's approval card. An answer on either surface resolves both.
 *
 * The decision record lives on the goal and is independent of the DM:
 *
 *   - `capDmPendingAt` — when the decision opened (undefined ⇒ none pending);
 *   - `capDecisionId`  — the round's id, issued at every opening, carried by
 *     the DM buttons and the card, and checked on every answer, so a button
 *     left over from an earlier round can never answer a later one;
 *   - `capDmRef`       — where the DM landed, stored only after the post
 *     succeeded (no ref ⇒ the DM is retried on the next cap trigger);
 *   - `capDmSync`      — a DM rewrite that has not reached Slack yet; retried
 *     in the background and again after a restart
 *     ({@link flushGoalCapDmSync}).
 *
 * Exactly once: Slack buttons and the dashboard route run in the same daemon
 * process against the same in-memory session, so {@link answerGoalCapDecision}
 * checks and ends the decision synchronously and persists it before its first
 * side effect. A second answer reads it as stale. A crash after the save and
 * before the loop is kicked is recovered by the post-restart goal resume —
 * still one Continue.
 */

import { randomUUID } from 'node:crypto';
import { Logger } from '../logger';
import type { ConversationSession, SessionGoal } from '../types';
import { resumeGoalLoop } from './goal-loop-resume';

const logger = new Logger('GoalCapDecision');

export type GoalCapDecision = 'continue' | 'cancel';
export type GoalCapDecisionSurface = 'slack' | 'dashboard';

export interface GoalCapDmRef {
  channel: string;
  ts: string;
}

/** The host side effects a decision needs. Wired once in `index.ts`. */
export interface GoalCapDecisionSurfaces {
  /** Rewrite the owner's DM (production: `chat.update`). */
  updateDm?: (ref: GoalCapDmRef, text: string) => Promise<unknown>;
  /** Push the dashboard board so the card appears or resolves at once. */
  broadcast?: () => void;
}

let surfaces: GoalCapDecisionSurfaces = {};

export function setGoalCapDecisionSurfaces(next: GoalCapDecisionSurfaces | null): void {
  surfaces = next ?? {};
}

export const GOAL_CAP_DECISION_LABELS: Record<GoalCapDecision, string> = {
  continue: '✅ 계속',
  cancel: '🛑 취소',
};

/** What the DM (and the Slack click's own message) says once the decision is answered. */
export function goalCapDecisionResolvedText(decision: GoalCapDecision, surface: GoalCapDecisionSurface): string {
  const base =
    decision === 'continue'
      ? '✅ goal을 계속 진행합니다.'
      : '🛑 goal을 중단했습니다. (`goal resume`으로 다시 시작할 수 있습니다.)';
  return surface === 'dashboard' ? `${base} — 대시보드에서 응답했습니다.` : base;
}

/** What a DM says when its round ended without an answer (a message, pause, done, a newer round). */
export const GOAL_CAP_DECISION_SUPERSEDED_TEXT =
  '⚠️ 이 요청은 더 이상 유효하지 않습니다 — goal 상태가 바뀌었습니다. 필요하면 스레드나 대시보드에서 다시 지시하세요.';

/** True while the goal waits on its owner's cap decision. */
export function isGoalCapDecisionPending(goal: SessionGoal | undefined): goal is SessionGoal {
  return !!goal && goal.status === 'active' && goal.capDmPendingAt !== undefined;
}

/**
 * Open the cap decision on an active goal: stamp when, and issue the round's
 * id. Returns false (and changes nothing) when a decision is already pending.
 */
export function openGoalCapDecision(goal: SessionGoal, now: number): boolean {
  if (goal.capDmPendingAt !== undefined) {
    // A record from before round ids existed: give it one so both surfaces can name it.
    if (!goal.capDecisionId) goal.capDecisionId = randomUUID();
    return false;
  }
  goal.capDmPendingAt = now;
  goal.capDecisionId = randomUUID();
  goal.capDmRef = undefined;
  return true;
}

/**
 * Record where the DM of round `decisionId` landed. A DM that arrives after
 * its round ended (answered on the dashboard, superseded) is rewritten to the
 * superseded line at once. Returns whether the ref was kept.
 */
export function recordGoalCapDm(goal: SessionGoal, decisionId: string, ref: GoalCapDmRef): 'recorded' | 'late' {
  if (isGoalCapDecisionPending(goal) && goal.capDecisionId === decisionId && !goal.capDmRef) {
    goal.capDmRef = ref;
    return 'recorded';
  }
  queueDmSync(goal, ref, GOAL_CAP_DECISION_SUPERSEDED_TEXT);
  return 'late';
}

/** The `{ channel, ts }` of a posted message (`chat.postMessage` result), or undefined. */
export function dmRefOf(posted: unknown): GoalCapDmRef | undefined {
  const p = posted as { channel?: unknown; ts?: unknown } | null | undefined;
  return p && typeof p.channel === 'string' && p.channel && typeof p.ts === 'string' && p.ts
    ? { channel: p.channel, ts: p.ts }
    : undefined;
}

export type GoalCapDecisionAnswer =
  | { ok: true; decision: GoalCapDecision; goal: SessionGoal }
  | { ok: false; reason: 'invalid' | 'stale' | 'not_owner' };

export interface AnswerGoalCapDecisionArgs {
  session: Pick<ConversationSession, 'goal' | 'systemPrompt'> | undefined;
  sessionKey: string;
  goalId: string;
  /** The round the answer was given for. Absent only on DMs sent before round ids existed. */
  decisionId?: string;
  /** Slack user id of whoever answers. */
  actor: string | undefined;
  decision: GoalCapDecision;
  surface: GoalCapDecisionSurface;
  /** Persist the sessions (synchronous). */
  save: () => void;
  now?: number;
}

/**
 * The one way a cap decision is answered — the Slack buttons and the
 * dashboard both call it. Only the goal's owner (`createdBy`) answers, only
 * the active goal's pending round, at most once.
 */
export function answerGoalCapDecision(args: AnswerGoalCapDecisionArgs): GoalCapDecisionAnswer {
  const { session, sessionKey, goalId, decisionId, actor, decision, surface } = args;
  if (!actor || (decision !== 'continue' && decision !== 'cancel')) return { ok: false, reason: 'invalid' };
  const goal = session?.goal;
  if (!session || !goal || goal.goalId !== goalId) return { ok: false, reason: 'stale' };
  if (goal.createdBy !== actor) return { ok: false, reason: 'not_owner' };
  if (!isGoalCapDecisionPending(goal)) return { ok: false, reason: 'stale' };
  if (decisionId === undefined) {
    // A button from before round ids existed: its round never recorded a DM ref.
    if (goal.capDmRef) return { ok: false, reason: 'stale' };
  } else if (decisionId !== goal.capDecisionId) {
    return { ok: false, reason: 'stale' };
  }

  // Synchronous from here to the save: no other answer can interleave.
  const ref = goal.capDmRef;
  endDecision(goal);
  if (decision === 'continue') {
    goal.continuationCount = 0;
    goal.status = 'active';
  } else {
    goal.status = 'paused';
  }
  goal.updatedAt = args.now ?? Date.now();
  // The same invalidation every goal-state change applies: an in-flight
  // completion eval discards its verdict, and the next turn rebuilds the
  // `<session-goal>` block.
  goal.epoch = (goal.epoch ?? 0) + 1;
  session.systemPrompt = undefined;
  // The Slack click rewrites its own message (respond); every other answer rewrites the DM here.
  if (ref && surface !== 'slack') goal.capDmSync = { ...ref, text: goalCapDecisionResolvedText(decision, surface) };
  args.save();

  if (decision === 'continue') resumeGoalLoop(sessionKey);
  if (goal.capDmSync) runDmSync(goal, args.save);
  surfaces.broadcast?.();
  return { ok: true, decision, goal };
}

/**
 * End a pending cap decision WITHOUT an answer — a real user message, pause,
 * done, eval completion, a cancelled opening. Its DM stops offering buttons.
 * Mutates the goal only; the caller persists as it already does.
 */
export function retireGoalCapDecision(goal: SessionGoal | undefined): void {
  if (!goal) return;
  const wasPending = goal.capDmPendingAt !== undefined;
  const ref = goal.capDmRef;
  endDecision(goal);
  if (ref) queueDmSync(goal, ref, GOAL_CAP_DECISION_SUPERSEDED_TEXT);
  // Deferred: the caller is mid-mutation and persists right after.
  if (wasPending && surfaces.broadcast) queueMicrotask(() => surfaces.broadcast?.());
}

function endDecision(goal: SessionGoal): void {
  goal.capDmPendingAt = undefined;
  goal.capDecisionId = undefined;
  goal.capDmRef = undefined;
}

function queueDmSync(goal: SessionGoal, ref: GoalCapDmRef, text: string): void {
  goal.capDmSync = { ...ref, text };
  runDmSync(goal);
}

/** Retry delays after a failed DM rewrite; once they run out the rewrite waits for the next restart. */
const DM_SYNC_RETRY_MS = [2_000, 15_000, 60_000];

function runDmSync(goal: SessionGoal, save?: () => void, attempt = 0): void {
  const pending = goal.capDmSync;
  const update = surfaces.updateDm;
  if (!pending || !update) return;
  update({ channel: pending.channel, ts: pending.ts }, pending.text).then(
    () => {
      // A newer rewrite may have replaced this one meanwhile — it runs on its own.
      if (goal.capDmSync === pending) {
        goal.capDmSync = undefined;
        save?.();
      }
    },
    (error: unknown) => {
      if (goal.capDmSync !== pending) return;
      const delay = DM_SYNC_RETRY_MS[attempt];
      if (delay === undefined) {
        logger.warn('Goal cap DM rewrite failed — kept for the next restart', {
          channel: pending.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const timer = setTimeout(() => runDmSync(goal, save, attempt + 1), delay);
      timer.unref?.();
    },
  );
}

/**
 * After a restart: rewrite every DM whose rewrite did not reach Slack before
 * the process stopped. `save` persists the cleared markers.
 */
export function flushGoalCapDmSync(sessions: Iterable<{ goal?: SessionGoal }>, save: () => void): number {
  let started = 0;
  for (const session of sessions) {
    if (session.goal?.capDmSync) {
      runDmSync(session.goal, save);
      started++;
    }
  }
  return started;
}
