/**
 * Goal actions the HOST performs on a session's goal list outside a typed
 * command: the dashboard work-item controls (add / delete-current /
 * delete-queued / pause / resume) and the Slack goal-list buttons.
 *
 * The implementation lives on `SlackHandler.handleHostGoalAction`, because a
 * started or promoted goal's opening turn has to be admitted through the
 * follow-up fence. This module only carries the contract, so the dashboard
 * route and the action handler can depend on it without importing the
 * handler.
 */

export type HostGoalAction =
  | { action: 'add'; objective: string }
  /**
   * Delete one goal. `expect` is where the caller SAW it: `current` (the
   * active/paused/complete goal), `queued`, or `paused` (the paused goals). A
   * goal that moved in the meantime — a queued goal promoted to current, a
   * current goal completed, a paused goal resumed — is refused as stale
   * instead of deleting something the user did not pick.
   */
  | { action: 'delete'; goalId: string; expect: 'current' | 'queued' | 'paused' }
  /**
   * Pause the CURRENT goal `goalId`: it moves to the paused goals and the next
   * queued goal starts (or, with none, the goal work ends). Refused as stale
   * when `goalId` is no longer the running (or paused-in-place) current goal.
   */
  | { action: 'pause'; goalId: string }
  /**
   * Resume the paused goal `goalId`: it becomes the current goal and starts at
   * once when no goal is running, otherwise it goes right after the running
   * goal (head of the queue). Refused as stale when it is no longer paused.
   */
  | { action: 'resume'; goalId: string };

export type HostGoalActionResult =
  /** Appended behind the goal in flight. */
  | { outcome: 'queued'; goalId: string; position: number }
  /** Became the active goal; its opening turn runs now or right after the current turn. */
  | { outcome: 'started'; goalId: string; opening: 'started' | 'queued' }
  /** Deleted; `promoted` is the next goal that became active, if any. */
  | { outcome: 'deleted'; goalId: string; promoted?: { goalId: string; objective: string } }
  /** Paused; `promoted` is the next goal that became active, if any (none — the goal work ended). */
  | { outcome: 'paused'; goalId: string; promoted?: { goalId: string; objective: string } }
  /**
   * Resumed. `current` — it is the current goal and its turn runs now or right
   * after the current turn (`opening`); `next` — it waits at the head of the
   * queue behind the running goal.
   */
  | { outcome: 'resumed'; goalId: string; placement: 'current'; opening: 'started' | 'queued' }
  | { outcome: 'resumed'; goalId: string; placement: 'next' };

/** A refusal with the HTTP status the dashboard answers with; the message is user-facing. */
export class HostGoalActionError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'HostGoalActionError';
  }
}
