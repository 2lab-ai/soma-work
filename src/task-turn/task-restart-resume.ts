/**
 * A Slack-less task's turn the restart cut, resumed after boot (2026-11-03).
 *
 * A Slack thread whose turn a restart cut is resumed (`notifyCrashRecovery`: the
 * restart prompt as the thread's next message). A dashboard task was not: its
 * turn was reconciled `interrupted` on load and nothing ran it again, so a long
 * task (a plan being worked) stopped at the restart. Now `loadSessions` lists
 * those tasks (`getRestartCutTasks`) and this resumer starts each one's next turn
 * through the task controller, as its owner, with the restart guidance as a
 * prompt notice — the conversation records only the short line.
 *
 * D10 (A0: a tool whose result is unknown is not re-run automatically) holds:
 * nothing replays the cut call. The model reads where it stopped and checks the
 * state of any write it may have made before doing it again.
 *
 * Skipped: a task someone instructed meanwhile (its last turn is not the cut
 * one), a task with an active goal (the goal loop resumes it), a closed or busy
 * task. The controller runs one dashboard task per owner, so a second cut task
 * of the same owner waits for the slot (429) and is retried.
 */
import type { ConversationSession } from '../types';
import { TASK_GOAL_START_MAX_RETRIES, TASK_GOAL_START_RETRY_MS } from './task-goal-loop';
import type { TaskCommandRequest, TaskCommandResponse, TaskTurnController } from './task-turn-controller';

/** What the conversation records as the resumed turn's instruction. */
export const TASK_RESTART_TEXT = '[재시작 후 자동 재개] 서비스가 재시작되어 중단된 작업을 이어서 진행합니다.';

/** What the model reads before it (never recorded): the Slack restart prompt, for a task. */
export const TASK_RESTART_NOTICE = [
  '<task-restart-resume>',
  '서비스가 재시작되어 이 작업의 이전 턴이 중단됐다(결과: interrupted). 대시보드 작업이라 Slack 스레드는 없다. 아래 순서로 이어 간다:',
  '1. 이 세션의 대화에서 마지막 지시와 어디까지 했는지 확인한다. 작업 계획이 있으면 그 계획의 어느 단계였는지 찾는다.',
  '2. 중단 직전의 도구 호출은 결과를 모른다. 파일 쓰기 · 커밋 · 푸시 · PR · 배포 · 메시지처럼 바깥을 바꾸는 호출은 다시 하기 전에 지금 상태부터 확인한다(git status · git log · gh pr view 등). 확인 없이 같은 호출을 되풀이하지 않는다.',
  '3. 멈춘 지점부터 남은 작업을 이어서 끝낸다.',
  '4. 어디까지 했는지 판단할 수 없으면 지금 상황을 설명하고 다음 단계를 묻는다.',
  '</task-restart-resume>',
].join('\n');

/** A task the last restart cut (`SessionRegistry.getRestartCutTasks`). */
export interface RestartCutTaskRef {
  sessionKey: string;
  ownerId: string;
  /** Who started the cut turn (the registry's record): the resume runs as them. Unset: the owner. */
  actorId?: string;
  turnId: string;
}

export interface TaskRestartResumerDeps {
  controller: Pick<TaskTurnController, 'start'>;
  getSession(sessionKey: string): ConversationSession | undefined;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
  /** Schedules a retry (production: an unref'd setTimeout). */
  schedule?: (fn: () => void, delayMs: number) => void;
  /** Between tries of a task whose owner's slot is busy. Default: the goal loop's ({@link TASK_GOAL_START_RETRY_MS}). */
  retryMs?: number;
  /**
   * Tries per task before giving up. Default: the goal loop's bound ({@link TASK_GOAL_START_MAX_RETRIES},
   * 10 minutes at the default pace) — an owner who went on to other work is not surprised by a cut
   * task starting hours later (trinity R4, fable P2).
   */
  maxAttempts?: number;
  /**
   * Did the boot's goal resume run? A cut task with an active goal is the goal resume's — unless it
   * did not run (the Slack notices before it threw): then this resume takes it, so it is not left
   * to neither (trinity R4, fable P2). Default: it ran.
   */
  goalsResumed?: () => boolean;
  /**
   * A cut task saved before its turn's initiator was kept (no `actorId`): who wrote the cut turn's
   * instruction, from the task's conversation (its last user turn's `userId`). Unknown: not resumed —
   * the owner's identity is never assumed for someone else's words (trinity R4, astra P1). Unset: none.
   */
  readCutTurnAuthor?: (session: ConversationSession, cutTurnId: string) => Promise<string | undefined>;
}

/** The start time a task turn's id carries (`<sessionKey>:<ms>:<uuid>`, task-turn-runner.ts), or undefined. */
export function taskTurnStartedAt(turnId: string): number | undefined {
  const parts = turnId.split(':');
  if (parts.length < 3) return undefined;
  const ms = Number(parts[parts.length - 2]);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

/**
 * The author of the cut turn's instruction, from the task's conversation: the last user turn recorded
 * at or after the cut turn started. An earlier turn is not proof — the cut turn's own input may never
 * have reached the disk (it is recorded after the start is saved) — so none answers undefined
 * (trinity R4, astra P1).
 */
export function cutTurnAuthor(
  turns: ReadonlyArray<{ role: string; timestamp: number; userId?: string }>,
  cutTurnId: string,
): string | undefined {
  const startedAt = taskTurnStartedAt(cutTurnId);
  if (startedAt === undefined) return undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== 'user') continue;
    if (turn.timestamp < startedAt) return undefined;
    return turn.userId || undefined;
  }
  return undefined;
}

export type RestartResumeOutcome =
  | { status: 'started' }
  | { status: 'waiting' }
  | { status: 'skipped'; reason: string }
  | { status: 'refused'; code: number; error: string };

/** Why a cut task is no longer resumed, or null while it still is. */
export function restartResumeSkip(
  session: ConversationSession | undefined,
  task: RestartCutTaskRef,
  opts: { goalsResumed?: boolean } = {},
): string | null {
  if (!session) return 'gone';
  if (session.slackless !== true) return 'not a dashboard task';
  if (session.terminated || session.closing) return 'closed';
  if (session.goal?.status === 'active' && opts.goalsResumed !== false) return 'active goal — the goal loop resumes it';
  // A plan the owner must decide (submitted, or cancelled): theirs, not a resume's — a host start would
  // read as their direct input and send the plan back to drafting (trinity R4, astra P2).
  if (session.taskPlan?.state === 'awaiting' || session.taskPlan?.state === 'cancelled') {
    return `the plan is ${session.taskPlan.state} — the owner decides`;
  }
  const last = session.lastTurnOutcome;
  if (!last || last.turnId !== task.turnId || last.outcome !== 'interrupted') return 'went on since the restart';
  if (session.activityState && session.activityState !== 'idle') return `not idle (${session.activityState})`;
  return null;
}

export interface TaskRestartResumer {
  /** Resume each cut task now; a task whose owner's slot is busy is retried. Resolves after the first round. */
  resume(tasks: readonly RestartCutTaskRef[]): Promise<Map<string, RestartResumeOutcome>>;
}

export function createTaskRestartResumer(deps: TaskRestartResumerDeps): TaskRestartResumer {
  const retryMs = deps.retryMs ?? TASK_GOAL_START_RETRY_MS;
  const maxAttempts = deps.maxAttempts ?? TASK_GOAL_START_MAX_RETRIES;
  const schedule =
    deps.schedule ??
    ((fn: () => void, delayMs: number) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
    });

  async function attempt(task: RestartCutTaskRef, tries: number): Promise<RestartResumeOutcome> {
    const skip = restartResumeSkip(deps.getSession(task.sessionKey), task, {
      goalsResumed: deps.goalsResumed?.() ?? true,
    });
    if (skip) {
      deps.logger.info('Restart resume skipped', { sessionKey: task.sessionKey, reason: skip });
      return { status: 'skipped', reason: skip };
    }
    let actor = task.actorId;
    if (!actor) {
      const session = deps.getSession(task.sessionKey);
      actor = session ? await deps.readCutTurnAuthor?.(session, task.turnId).catch(() => undefined) : undefined;
      if (!actor) {
        deps.logger.info('Restart resume skipped', {
          sessionKey: task.sessionKey,
          reason: 'who started the cut turn is not recorded — the owner resumes it',
        });
        return { status: 'skipped', reason: 'who started the cut turn is not recorded' };
      }
      task = { ...task, actorId: actor };
      // The read awaited: the task may have moved on meanwhile (a cancelled plan, a turn) — check again.
      const late = restartResumeSkip(deps.getSession(task.sessionKey), task, {
        goalsResumed: deps.goalsResumed?.() ?? true,
      });
      if (late) {
        deps.logger.info('Restart resume skipped', { sessionKey: task.sessionKey, reason: late });
        return { status: 'skipped', reason: late };
      }
    }
    let response: TaskCommandResponse;
    try {
      response = await deps.controller.start({
        sessionKey: task.sessionKey,
        text: TASK_RESTART_TEXT,
        // As the person who started the cut turn — never lifted to the owner's identity (trinity R4, astra P1).
        actorUserId: actor,
        initiator: 'host',
        promptNotice: TASK_RESTART_NOTICE,
      });
    } catch (error) {
      deps.logger.warn('Restart resume failed to start', {
        sessionKey: task.sessionKey,
        error: (error as Error)?.message ?? String(error),
      });
      return { status: 'refused', code: 500, error: (error as Error)?.message ?? String(error) };
    }
    if (response.status === 202) {
      deps.logger.info('Resumed a dashboard task the restart cut', { sessionKey: task.sessionKey, tries });
      return { status: 'started' };
    }
    const error = String((response.body as { error?: unknown } | undefined)?.error ?? `HTTP ${response.status}`);
    // 429: the owner's one dashboard task (or the start window) is taken — another resumed task, or
    // their own new instruction. Try again later; the skip check above stops it once they went on.
    if (response.status === 429 && tries < maxAttempts) {
      schedule(() => {
        void attempt(task, tries + 1);
      }, retryMs);
      deps.logger.info('Restart resume waits for the owner’s slot', { sessionKey: task.sessionKey, tries, error });
      return { status: 'waiting' };
    }
    deps.logger.warn('Restart resume refused', { sessionKey: task.sessionKey, status: response.status, error });
    return { status: 'refused', code: response.status, error };
  }

  return {
    async resume(tasks) {
      const outcomes = new Map<string, RestartResumeOutcome>();
      // One after another: the first of an owner's tasks takes the slot, the rest wait for it.
      for (const task of tasks) outcomes.set(task.sessionKey, await attempt(task, 1));
      return outcomes;
    },
  };
}

export interface RestartNoticeStartDeps {
  /** The task controller's `start`. */
  start(request: TaskCommandRequest): Promise<TaskCommandResponse>;
  getSession(sessionKey: string): ConversationSession | undefined;
  /** Tasks the restart cut whose goal resumes: key → the cut turn (filled at boot). */
  cut: Map<string, string>;
}

/**
 * The goal loop's start for a dashboard task, with D10 on the goal path: a cut task with a goal is
 * resumed by the goal resume, not by {@link createTaskRestartResumer} — so its first goal continuation
 * carries the same restart guidance (check the state before redoing an outside change). Only while
 * nothing ran since the cut turn, and handed out with the turn that is taken: a refusal the loop
 * waits out (429) retries with the guidance still on (trinity R4, grok P1).
 */
export function createRestartNoticeStart(
  deps: RestartNoticeStartDeps,
): (request: TaskCommandRequest) => Promise<TaskCommandResponse> {
  return async (request) => {
    const cutTurn = deps.cut.get(request.sessionKey);
    if (cutTurn === undefined || request.goalContinuation !== true) return deps.start(request);
    if (deps.getSession(request.sessionKey)?.lastTurnOutcome?.turnId !== cutTurn) {
      deps.cut.delete(request.sessionKey);
      return deps.start(request);
    }
    const response = await deps.start({ ...request, promptNotice: TASK_RESTART_NOTICE });
    if (response.status >= 200 && response.status < 300) deps.cut.delete(request.sessionKey);
    return response;
  };
}
