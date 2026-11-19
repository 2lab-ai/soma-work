/**
 * The dashboard's stop of a working session (`setDashboardStopHandler`).
 *
 * A stop cuts the running turn (the request coordinator's abort, tagged `user-stop`). When a goal
 * is running, the cut turn's end drives that goal and the goal starts its next turn — the stop does
 * not hold. So the card asks first, and with the owner's yes the stop carries `pauseGoalId`: the
 * goal is paused BEFORE the turn is cut, and a pause that is refused (another goal runs now, the
 * session is gone or closed) throws — then nothing is stopped and the route says why.
 */
export interface DashboardStopDeps {
  /** `SlackHandler.pauseGoalForStop` — synchronous; throws a `HostGoalActionError` when it refuses. */
  pauseGoalForStop(
    sessionKey: string,
    goalId: string,
  ): { outcome: 'paused'; inPlace: boolean } | { outcome: 'not-running' };
  abort(sessionKey: string): void;
  logger: { info(msg: string, meta?: unknown): void };
}

export function createDashboardStopHandler(
  deps: DashboardStopDeps,
): (sessionKey: string, opts?: { pauseGoalId?: string }) => Promise<void> {
  return async (sessionKey, opts) => {
    // Paused first, in the same tick as the abort: no turn end can fall between the two.
    const goal = opts?.pauseGoalId ? deps.pauseGoalForStop(sessionKey, opts.pauseGoalId) : undefined;
    deps.abort(sessionKey);
    deps.logger.info('Dashboard: stopped session', { sessionKey, ...(goal ? { goal: goal.outcome } : {}) });
  };
}
