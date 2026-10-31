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
 * A refusal is a `SessionDeleteRefusedError`, which the close route answers
 * with 409 and the reason.
 */
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
      await deps.closeTask(sessionKey);
    }
    deps.terminate(sessionKey);
    deps.logger.info('Dashboard: closed session', { sessionKey });
  };
}
