/**
 * Late-bound bridge to the goal auto-continuation loop.
 *
 * The `GoalLoopController` is constructed in `index.ts` AFTER the Slack action
 * delegates are wired, so action handlers cannot capture it directly. This
 * module is a tiny settable singleton: `index.ts` registers the controller's
 * trigger here, and the goal action handlers (Delete-advance, owner-DM
 * Continue) call {@link resumeGoalLoop} to kick the loop for a session.
 */

import type { HostGoalAction, HostGoalActionResult } from './goal-host-actions';

type GoalResumeFn = (sessionKey: string) => void;

let resumeFn: GoalResumeFn | undefined;

/** Wire the controller's trigger (production: `goalLoopController.onTurnSettled`). */
export function setGoalLoopResumeHandler(fn: GoalResumeFn): void {
  resumeFn = fn;
}

/** Kick the goal loop for a session. No-op until the handler is wired. */
export function resumeGoalLoop(sessionKey: string): void {
  resumeFn?.(sessionKey);
}

type HostGoalActionFn = (
  sessionKey: string,
  action: HostGoalAction,
  actorUserId?: string,
) => Promise<HostGoalActionResult>;

let hostGoalActionFn: HostGoalActionFn | undefined;

/**
 * Wire the host's goal-list action (production: `SlackHandler.handleHostGoalAction`).
 * The goal-list Delete button routes through it so deleting the current goal
 * starts the promoted goal exactly like the dashboard does — its opening turn
 * admitted through the follow-up fence — instead of only kicking the loop.
 */
export function setHostGoalActionHandler(fn: HostGoalActionFn): void {
  hostGoalActionFn = fn;
}

/** The wired host goal action, or `undefined` before `index.ts` wires it. */
export function getHostGoalActionHandler(): HostGoalActionFn | undefined {
  return hostGoalActionFn;
}
