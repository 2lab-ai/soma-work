/**
 * The dashboard's close of a session (`setDashboardCloseHandler`).
 *
 * #854 — a Slack epic and its children are Slack sessions: closing the epic marks each running
 * child closed by its parent and stops its turn (the request coordinator's abort), then the epic
 * is terminated; closing a child records its close on its epic. The children's threads stay.
 * Every other session is simply terminated. (The dashboard-task close beside this — a task's
 * chain cancelled and committed, the notice ledger's refusal — was removed in #855.)
 *
 * A refusal is a `SessionDeleteRefusedError` (the registry's deletion observer), which the close
 * route answers with 409 and the reason.
 */
import type { ConversationSession } from '../types';

export interface DashboardCloseDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  terminate(sessionKey: string): unknown;
  /** E4 ⑦ — an epic's live children; the two records a close writes. */
  getChildTasks(parentTaskId: string): ConversationSession[];
  markClosedByParent(sessionKey: string): void;
  recordChildClosed(sessionKey: string): void;
  /** E4 ⑦ — the in-memory "being closed" mark: set before anything stops, cleared if the close fails. */
  markClosing(sessionKey: string, closing: boolean): void;
  /** #854 — a Slack session's registry key; whether its turn runs now; stop that turn. */
  keyOf(session: ConversationSession): string | undefined;
  isRunning(sessionKey: string): boolean;
  abort(sessionKey: string): void;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export function createDashboardCloseHandler(deps: DashboardCloseDeps): (sessionKey: string) => Promise<void> {
  return async (sessionKey) => {
    const closing = deps.getSession(sessionKey);
    // #854 — a session in an epic tree (the epic, or one of its children).
    const tree = !!closing && (closing.kind === 'epic' || !!closing.parentTaskId) ? closing : undefined;
    // Marked first: an epic being closed takes no wake (its children's ends would wake it) and
    // starts nothing; a child being closed owes no wake (fable #703 R1). Cleared if the close fails.
    if (tree) deps.markClosing(sessionKey, true);
    try {
      if (tree) closeTree(tree, sessionKey);
      deps.terminate(sessionKey);
    } catch (error) {
      if (tree) deps.markClosing(sessionKey, false);
      throw error;
    }
    deps.logger.info('Dashboard: closed session', { sessionKey });
  };

  /** #854 — the epic's running children stop first (marked closed by it); a child's close is its epic's event. */
  function closeTree(session: ConversationSession, sessionKey: string): void {
    if (session.kind === 'epic' && session.taskId) {
      const running = deps
        .getChildTasks(session.taskId)
        .flatMap((c) => {
          const key = deps.keyOf(c);
          return key ? [key] : [];
        })
        .filter((key) => deps.isRunning(key));
      for (const key of running) {
        try {
          deps.markClosedByParent(key);
        } catch (error) {
          // Not saved: the child still stops; only the "closed by its parent" mark is missing —
          // the close the owner asked for goes on.
          deps.logger.warn('Epic close: a running child could not be marked closed by its parent', {
            sessionKey: key,
            error: (error as Error)?.message,
          });
        }
        deps.abort(key);
      }
    }
    if (session.parentTaskId) {
      try {
        deps.recordChildClosed(sessionKey);
      } catch (error) {
        deps.logger.warn('Child close: its epic could not record the close', {
          sessionKey,
          error: (error as Error)?.message,
        });
      }
    }
  }
}
