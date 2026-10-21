/**
 * Goal actions the HOST performs on a session's goal list outside a typed
 * command: the dashboard work-item controls (add / delete-current /
 * delete-queued) and the Slack goal-list Delete button.
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
   * active/paused/complete goal) or `queued`. A goal that moved in the
   * meantime — a queued goal promoted to current, a current goal completed —
   * is refused as stale instead of deleting something the user did not pick.
   */
  | { action: 'delete'; goalId: string; expect: 'current' | 'queued' };

export type HostGoalActionResult =
  /** Appended behind the goal in flight. */
  | { outcome: 'queued'; goalId: string; position: number }
  /** Became the active goal; its opening turn runs now or right after the current turn. */
  | { outcome: 'started'; goalId: string; opening: 'started' | 'queued' }
  /** Deleted; `promoted` is the next goal that became active, if any. */
  | { outcome: 'deleted'; goalId: string; promoted?: { goalId: string; objective: string } };

/** A refusal with the HTTP status the dashboard answers with; the message is user-facing. */
export class HostGoalActionError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'HostGoalActionError';
  }
}
