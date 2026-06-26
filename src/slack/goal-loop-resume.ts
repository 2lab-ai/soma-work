/**
 * Late-bound bridge to the goal auto-continuation loop.
 *
 * The `GoalLoopController` is constructed in `index.ts` AFTER the Slack action
 * delegates are wired, so action handlers cannot capture it directly. This
 * module is a tiny settable singleton: `index.ts` registers the controller's
 * trigger here, and the goal action handlers (Delete-advance, owner-DM
 * Continue) call {@link resumeGoalLoop} to kick the loop for a session.
 */

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
