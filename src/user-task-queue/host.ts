/**
 * The host side of the per-user task queue: builds the queue and its limits from the process's parts, starts an
 * entry when its turn comes, and decides when to look.
 *
 * - **Start** — a `request` entry is replayed through the ingress as it arrived, with its admission
 *   (`routeContext.userTaskEntryId`); a `resume` entry (a task stopped by 먼저 진행) gets one host turn that carries
 *   it on. Both go through `handleMessage`, whose fence runs synchronously — the slot is taken before `start` returns.
 * - **When** — a chain settling (a task ended, or stopped to ask its owner) asks for a release shortly after (the
 *   goal loop registers its next turn first); a tick looks every few seconds as a safety net, and not at all in the
 *   first seconds after a restart (the turns a restart cut resume first).
 * - **Stop** (먼저 진행) — the running task's turn is aborted as `user-interrupted`: the turn that replaces it runs
 *   now, and the follow-up queue is not frozen. A turn that is still starting has no stop handle yet: the stop is
 *   tried again until it lands. Nothing starts while the host shuts down.
 */
import { Logger } from '../logger';
import type { UserTaskEntry } from './ledger';
import { RESUME_PROMPT } from './slack-notice';
import { createUserTaskSlackNotifier, type UserTaskSlackApi } from './slack-surface';
import { createUserTaskQueueStore, UserTaskLimits } from './store';
import { DEFAULT_TASK_LIMIT, type RunningTask, UserTaskQueue } from './user-task-queue';

export const USER_TASK_QUEUE_TICK_MS = 3_000;
export const USER_TASK_QUEUE_BOOT_GRACE_MS = 20_000;
export const USER_TASK_QUEUE_RELEASE_DELAY_MS = 600;
export const USER_TASK_QUEUE_ABORT_RETRY_MS = 500;
export const USER_TASK_QUEUE_ABORT_RETRY_FOR_MS = 60_000;

type Say = (args: any) => Promise<{ ts?: string }>;

export interface UserTaskQueueHostDeps {
  dataDir: string;
  isAdmin(userId: string): boolean;
  /** The person's tasks that run now (`SlackHandler.runningTasksOf`). */
  runningTasksOf(userId: string): RunningTask[];
  /** The thread's turn holds its slot, or its goal loop is about to run the next one. */
  isTaskRunning(sessionKey: string): boolean;
  /** The thread's turn holds its slot (a turn runs, or is starting) — not just its goal loop between turns. */
  isTurnBusy(sessionKey: string): boolean;
  /** The session is there and not closed (a stopped task can be carried on). */
  sessionAlive(sessionKey: string): boolean;
  handleMessage(event: Record<string, unknown>, say: Say): Promise<unknown>;
  makeSay(channel: string, threadTs?: string): Say;
  /** Abort a running turn as `user-interrupted`; true when one was aborted. */
  abort(sessionKey: string): boolean;
  slackApi: UserTaskSlackApi;
  /** The queue changed (repaint the dashboard). */
  onChange(): void;
  /** The host stops: nothing is started any more (a turn started now would be killed, and replayed after). */
  isShuttingDown?(): boolean;
  /** A channel whose tasks are private (a DM, a private channel): their titles stay out of other threads. */
  isPrivateChannel?(channel: string): boolean;
  logger?: Logger;
  now?: () => number;
  /** How often, and how long, a 먼저 진행 stop is tried again while the turn has no stop handle yet. */
  abortRetryMs?: number;
  abortRetryForMs?: number;
}

export interface UserTaskQueueHost {
  queue: UserTaskQueue;
  limits: UserTaskLimits;
  release(userId?: string): void;
  /** A chain settled somewhere: look again shortly. */
  scheduleRelease(): void;
  start(intervalMs?: number): void;
  stop(): void;
}

/** The event that carries a stopped task on (the person did not write it). */
export function resumeEvent(entry: UserTaskEntry): Record<string, unknown> {
  return {
    user: entry.userId,
    channel: entry.channel,
    thread_ts: entry.threadTs,
    ts: '',
    text: RESUME_PROMPT,
    synthetic: true,
    skipDispatch: true,
    routeContext: { skipAutoBotThread: true, verbatimPrompt: true, hostTurn: true, userTaskEntryId: entry.id },
  };
}

/** The held request as it arrived, with its admission. */
export function replayEvent(entry: UserTaskEntry): Record<string, unknown> {
  const message = entry.message;
  if (!message) throw new Error('queued request has no message');
  const route = (message.routeContext as Record<string, unknown> | undefined) ?? {};
  return { ...message, routeContext: { ...route, userTaskEntryId: entry.id } };
}

export function createUserTaskQueueHost(deps: UserTaskQueueHostDeps): UserTaskQueueHost {
  const logger = deps.logger ?? new Logger('UserTaskQueueHost');
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const limits = new UserTaskLimits(deps.dataDir, deps.isAdmin, DEFAULT_TASK_LIMIT);
  let queueRef: UserTaskQueue | undefined;
  const notify = createUserTaskSlackNotifier({
    slackApi: deps.slackApi,
    queue: () => queueRef,
    isPrivateChannel: deps.isPrivateChannel,
    logger,
  });
  const retryEvery = deps.abortRetryMs ?? USER_TASK_QUEUE_ABORT_RETRY_MS;
  const retryFor = deps.abortRetryForMs ?? USER_TASK_QUEUE_ABORT_RETRY_FOR_MS;
  /**
   * 먼저 진행 on a turn that is still starting (its stop handle is registered only after session setup): try again
   * until the stop lands, the turn ends by itself, or the time runs out — and tell the queue which (`stopResolved`):
   * the entry that goes first waits for the slot either way, and only a stopped task is carried on later.
   */
  const keepStopping = (sessionKey: string) => {
    const until = now() + retryFor;
    const timer = setInterval(() => {
      let landed: boolean | undefined;
      if (deps.abort(sessionKey)) landed = true;
      else if (!deps.isTurnBusy(sessionKey) || now() > until) landed = false;
      if (landed === undefined) return;
      clearInterval(timer);
      if (!landed)
        logger.info('User task queue: 먼저 진행 stop did not land — the task is not carried on', { sessionKey });
      queueRef?.stopResolved(sessionKey, landed);
    }, retryEvery);
    timer.unref?.();
  };

  const run = (event: Record<string, unknown>) => {
    const channel = String(event.channel ?? '');
    const threadTs = (event.thread_ts as string | undefined) || (event.ts as string | undefined);
    deps.handleMessage(event, deps.makeSay(channel, threadTs)).catch((error: unknown) => {
      logger.warn('User task queue: a started entry failed in the pipeline', {
        channel,
        threadTs,
        error: (error as Error)?.message ?? String(error),
      });
    });
  };

  const queue = new UserTaskQueue({
    store: createUserTaskQueueStore(deps.dataDir),
    limitFor: (userId) => limits.limitFor(userId),
    runningTasks: (userId) => deps.runningTasksOf(userId),
    start: (entry) => {
      if (entry.kind === 'resume') {
        if (!deps.sessionAlive(entry.sessionKey)) throw new Error('the stopped task is gone');
        run(resumeEvent(entry));
      } else {
        run(replayEvent(entry));
      }
      logger.info('User task queue: entry started', {
        entry: entry.id,
        kind: entry.kind,
        sessionKey: entry.sessionKey,
      });
    },
    interrupt: (task) => {
      if (deps.abort(task.sessionKey)) return 'stopped';
      // It already ended: nothing to stop, nothing to carry on later.
      if (!deps.isTaskRunning(task.sessionKey)) return 'gone';
      // Between goal turns nothing runs: the gate holds its next turn (its thread now waits in line).
      if (!deps.isTurnBusy(task.sessionKey)) return 'stopped';
      keepStopping(task.sessionKey);
      return 'pending';
    },
    notify,
    onChange: () => deps.onChange(),
    now,
  });
  queueRef = queue;

  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const release = (userId?: string) => {
    if (deps.isShuttingDown?.()) return;
    try {
      queue.release(userId);
    } catch (error) {
      logger.warn('User task queue: release failed', { error: (error as Error)?.message ?? String(error) });
    }
  };
  const tick = () => {
    if (now() - startedAt < USER_TASK_QUEUE_BOOT_GRACE_MS) return;
    if (queue.usersWaiting().length === 0) return;
    release();
  };

  return {
    queue,
    limits,
    release,
    scheduleRelease: () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        // Not in the boot grace either: the turns a restart cut resume first, whichever way the release is asked for.
        if (now() - startedAt < USER_TASK_QUEUE_BOOT_GRACE_MS) return;
        if (queue.usersWaiting().length > 0) release();
      }, USER_TASK_QUEUE_RELEASE_DELAY_MS);
      pending.unref?.();
    },
    start: (intervalMs = USER_TASK_QUEUE_TICK_MS) => {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      if (pending) clearTimeout(pending);
      timer = undefined;
      pending = undefined;
    },
  };
}
