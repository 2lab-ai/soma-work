/**
 * The dashboard's close of a session (`setDashboardCloseHandler`), with a
 * task's two rules:
 *
 *   - a running chain ends `cancelled` (session-close) and commits its outcome
 *     before the task is archived and removed (598c v2 a2);
 *   - with no notice ledger (E2 ⑤, D6) a task that still owes its instruction
 *     thread cannot be deleted — refused here, BEFORE its chain is cancelled,
 *     so the work does not stop for a close that would be refused anyway
 *     (fable #668 P3-4).
 *
 * E4 ⑦ (D10 b · c) — closing an epic first marks each running child
 * `closedBy: parent` (saved now) and cancels it (session-close), all at once;
 * the child cards stay, under the epic, on the normal clock. Closing a child
 * adds a `closed` event to its epic before it goes.
 *
 * A refusal is a `SessionDeleteRefusedError`, which the close route answers
 * with 409 and the reason.
 */
import { buildTaskSessionKey } from '../session-identity';
import { SessionDeleteRefusedError } from '../session-registry';
import type { ConversationSession } from '../types';
import { owesInstructionThread } from './task-notice-deliverer';

export interface DashboardCloseDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  /** The task controller's close: cancels and commits a running chain. */
  closeTask(sessionKey: string): Promise<unknown>;
  terminate(sessionKey: string): unknown;
  /** The notice ledger could not be read at boot. */
  ledgerUnreadable(): boolean;
  /** E4 ⑦ — an epic's live children; whether a task's chain runs; the two records a close writes. */
  getChildTasks(parentTaskId: string): ConversationSession[];
  isRunning(sessionKey: string): boolean;
  markClosedByParent(sessionKey: string): void;
  recordChildClosed(sessionKey: string): void;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export function createDashboardCloseHandler(deps: DashboardCloseDeps): (sessionKey: string) => Promise<void> {
  return async (sessionKey) => {
    const closing = deps.getSession(sessionKey);
    if (closing?.slackless === true) {
      if (deps.ledgerUnreadable() && owesInstructionThread(closing)) {
        deps.logger.warn('Dashboard close refused: the notice ledger is unreadable and the task owes its thread', {
          sessionKey,
        });
        throw new SessionDeleteRefusedError(
          sessionKey,
          'terminated',
          new Error('task notice ledger unreadable — kept until its notices can be handed over'),
        );
      }
      if (closing.kind === 'epic' && closing.taskId) {
        const running = deps
          .getChildTasks(closing.taskId)
          .flatMap((c) => (c.taskId ? [buildTaskSessionKey(c.taskId)] : []))
          .filter((key) => deps.isRunning(key));
        for (const key of running) {
          try {
            deps.markClosedByParent(key);
          } catch (error) {
            // Not saved: the child still stops (its outcome is cancelled); only the "closed by
            // its parent" mark is missing — the close the owner asked for goes on.
            deps.logger.warn('Epic close: a running child could not be marked closed by its parent', {
              sessionKey: key,
              error: (error as Error)?.message,
            });
          }
        }
        await Promise.all(running.map((key) => deps.closeTask(key)));
      }
      if (closing.parentTaskId) {
        try {
          deps.recordChildClosed(sessionKey);
        } catch (error) {
          deps.logger.warn('Child close: its epic could not record the close', {
            sessionKey,
            error: (error as Error)?.message,
          });
        }
      }
      await deps.closeTask(sessionKey);
    }
    deps.terminate(sessionKey);
    deps.logger.info('Dashboard: closed session', { sessionKey });
  };
}
