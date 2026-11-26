/**
 * .prd/39 D9 · I5 · 40 §2 — one way a goal change ends. The transition (`@soma/slack/goal/machine`) changed the
 * session's goal fields; this commits it: the epoch moves (`bumpEpoch` — an in-flight judge discards its verdict, a
 * stale retry window ends), the cached `<session-goal>` prompt is dropped, the sessions are saved, the dashboard hears
 * it, and the drive the change owes is paid.
 *
 * `drive: 'kick'` enqueues the goal loop (its serial queue — a judge in flight finishes, sees the moved epoch, and the
 * kick behind it judges once more). While a turn is held the loop's gate leaves the drive to that turn
 * (`holdGoalDriverForTurn`). `'none'` owes nothing: the change stopped the goal, or a turn it starts drives it.
 *
 * A transition that must order its effects around the save (the cap answer: journal → save → DM rewrite, undo on a
 * failed save) keeps its own order (`answerGoalCapDecision`) and does not come through here.
 */
import { bumpEpoch } from '@soma/slack/goal/machine';
import type { ConversationSession, SessionGoal } from '../types';

export interface GoalChange {
  /** What the change owes the loop (I5). */
  drive: 'kick' | 'none';
  /** The goal whose intent changed when it is not the slot's (a queued goal's edit). Default: `session.goal`. */
  goal?: SessionGoal;
}

export interface GoalCommitPorts {
  saveSessions(): void;
  broadcastSessionUpdate?(): void;
  /** Enqueue the goal loop for the session (production: `resumeGoalLoop`). */
  kick(sessionKey: string): void;
}

export function commitGoalChange(
  session: ConversationSession,
  sessionKey: string,
  change: GoalChange,
  ports: GoalCommitPorts,
): void {
  // `clear` leaves no goal to bump — the judge's epoch guard catches that through the missing goal.
  const changed = change.goal ?? session.goal;
  if (changed) bumpEpoch(changed);
  session.systemPrompt = undefined;
  ports.saveSessions();
  // Goal state is on the dashboard card (status, queue, a re-check the bump just dropped) — push it now.
  ports.broadcastSessionUpdate?.();
  if (change.drive === 'kick' && session.goal?.status === 'active') ports.kick(sessionKey);
}
