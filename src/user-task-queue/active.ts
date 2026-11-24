/**
 * The process's per-user task queue and limits, for the readers wired after it (the dashboard board, its 먼저 진행 /
 * 대기 취소 routes and the settings knob). Absent until `index.ts` wires them, and in tests that do not.
 */
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

/**
 * Whether a host event of `userId`'s in `sessionKey` (a pr-watch CI or review message) may start now: they have a
 * free slot and nothing of theirs waits (`UserTaskQueue.hasFreeSlot`). Free when no queue is wired, the owner is not
 * known, or the queue cannot say — a host event is never held forever by the queue failing.
 */
export function userTaskSlotFree(userId: string | undefined, sessionKey: string): boolean {
  if (!active || !userId) return true;
  try {
    return active.queue.hasFreeSlot(userId, sessionKey);
  } catch {
    return true;
  }
}
