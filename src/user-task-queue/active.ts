/**
 * The process's per-user task queue and limits, for the readers wired after it (the dashboard board, its 먼저 진행 /
 * 대기 취소 routes and the settings knob). Absent until `index.ts` wires them, and in tests that do not.
 */
import { Logger } from '../logger';
import type { UserTaskLimits } from './store';
import type { UserTaskQueue } from './user-task-queue';

export interface ActiveUserTaskQueue {
  queue: UserTaskQueue;
  limits: UserTaskLimits;
  /** Start what may start now (after a limit changed). */
  release(userId?: string): void;
}

let active: ActiveUserTaskQueue | undefined;

export function setActiveUserTaskQueue(next: ActiveUserTaskQueue | undefined): void {
  active = next;
}

export function getActiveUserTaskQueue(): ActiveUserTaskQueue | undefined {
  return active;
}

const logger = new Logger('UserTaskQueue');

/**
 * Whether a host event of `userId`'s in `sessionKey` (a pr-watch CI or review message) may start now: they have a
 * free slot and nothing of theirs waits (`UserTaskQueue.hasFreeSlot`). Free when no queue is wired or the owner is not
 * known. A queue that cannot say fails open — a host event is never held forever — and says so in the log.
 */
export function userTaskSlotFree(userId: string | undefined, sessionKey: string): boolean {
  if (!active || !userId) return true;
  try {
    return active.queue.hasFreeSlot(userId, sessionKey);
  } catch (error) {
    logger.warn('User task queue: free-slot check failed — the host event is not held', {
      userId,
      sessionKey,
      error: (error as Error)?.message ?? String(error),
    });
    return true;
  }
}

/** Reserve that slot as the host event is sent (`UserTaskQueue.reserveHostTurn`); fails open like the check. */
export function reserveUserTaskHostTurn(userId: string | undefined, sessionKey: string): boolean {
  if (!active || !userId) return true;
  try {
    return active.queue.reserveHostTurn(userId, sessionKey);
  } catch (error) {
    logger.warn('User task queue: host turn reservation failed', {
      userId,
      sessionKey,
      error: (error as Error)?.message ?? String(error),
    });
    return true;
  }
}
