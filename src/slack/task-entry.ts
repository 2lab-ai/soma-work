/**
 * E2 ⑧ — the Slack entry (.prd/18 D1 · D2 · D3 · D11 · D12).
 *
 * A plain instruction from a user who turned it on becomes a dashboard task:
 * the thread gets the card link (posted by the notice deliverer — the task's
 * first save owes it), then only results and input requests. The order is
 * fixed and a step that stops the entry leaves every later one undone:
 *
 *   allow-list → new-user gate → dashboard listening → canStart → create
 *   (instruction thread + channel context) → start
 *
 * and a live task's instruction thread is protected: anything that would run
 * there is answered with the card link instead (`guard`).
 *
 * Replies go through the `say` the dispatcher held for this run, always in the
 * instruction thread. Nothing here calls the task runner or posts a notice.
 */
import type { DispatchOutcome } from '@soma/slack/followup-dispatcher';
import type { TaskLaunchRequest } from '../task-turn/task-launcher';
import type { TaskCommandResponse } from '../task-turn/task-turn-controller';
import type { ConversationSession, TaskInputContext } from '../types';

/** D2 (3): what must hold for a message to become a task — the host re-checks the router's hint. */
export interface TaskEntryAllowList {
  /** The router marked the original mention a plain instruction (`routeContext.taskEntryCandidate`). */
  candidate: boolean;
  dm: boolean;
  /** The thread already has a Slack session: it stays one (D2 (2) connection order). */
  hasSession: boolean;
  /** A `/z` objective re-entering verbatim. */
  verbatim: boolean;
  /** A goal opening turn (`routeContext.goalOpeningId`). */
  goalOpening: boolean;
  /** A `!` abort/steer. */
  steer: boolean;
  /** Inline `%` directives were on the message. */
  inlineDirective: boolean;
  handled: boolean;
  continueWithPrompt: boolean;
  deferredSkillFire: boolean;
  forceWorkflow: boolean;
  setGoalObjective: boolean;
  inlineModel: boolean;
  inlineNoGoal: boolean;
  /** Attachments: a task takes none (D8 of A0). */
  fileCount: number;
}

export function isTaskEntryAllowed(a: TaskEntryAllowList): boolean {
  return (
    a.candidate &&
    !a.dm &&
    !a.hasSession &&
    !a.verbatim &&
    !a.goalOpening &&
    !a.steer &&
    !a.inlineDirective &&
    !a.handled &&
    !a.continueWithPrompt &&
    !a.deferredSkillFire &&
    !a.forceWorkflow &&
    !a.setGoalObjective &&
    !a.inlineModel &&
    !a.inlineNoGoal &&
    a.fileCount === 0
  );
}

export interface SlackTaskEntryDeps {
  /** D1 — the user turned it on (`slackTaskEntry`). Read only when a task would be made. */
  isEnabled(userId: string): boolean;
  /** D12 — the dashboard is listening. */
  isDashboardListening(): boolean;
  /** The new-user approval gate (`runNewUserGate`), posting in the instruction thread. */
  newUserGate(at: {
    user: string;
    userName: string;
    channel: string;
    threadTs: string;
  }): Promise<'pass' | 'new' | 'pending'>;
  getUserName(userId: string): Promise<string>;
  /** D11 — the controller's dry run: null, or the refusal a start would get. */
  canStart(ownerId: string, text: string): TaskCommandResponse | null;
  /** The dashboard's launcher: fresh folder → createTask → start. */
  launch(request: TaskLaunchRequest): Promise<TaskCommandResponse>;
  getTaskByKey(sessionKey: string): ConversationSession | undefined;
  getTaskByOriginThread(channel: string, threadTs: string): ConversationSession | undefined;
  /** D6's fourth producer — made but not started. */
  notStarted(session: ConversationSession, sessionKey: string, reason: string): void;
  cardUrl(ownerId: string, sessionKey: string): string | undefined;
  /** D4 — the channel's name, description and repos for the task's prompt. */
  inputContext(channel: string): Promise<TaskInputContext | undefined>;
  reactions: {
    remove(channel: string, ts: string, name: string): Promise<unknown>;
    add(channel: string, ts: string, name: string): Promise<unknown>;
  };
  logger: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
  now?(): number;
}

type Say = (message: { text: string; thread_ts: string }) => Promise<unknown>;

export interface SlackTaskEntry {
  /**
   * After the host's command routing: undefined → not a task, the Slack path
   * goes on; an outcome → the entry answered the message.
   */
  run(input: {
    event: { user: string; channel: string; ts: string; thread_ts?: string; text?: string };
    say: Say;
    allow: TaskEntryAllowList;
  }): Promise<DispatchOutcome | undefined>;
  /**
   * D2 (2) — true when this thread is a live task's instruction thread and the
   * message was answered (a card-link notice, or silence for a redelivery);
   * nothing may run for it.
   */
  guard(event: { channel: string; ts: string; thread_ts?: string; files?: unknown[] }, say: Say): Promise<boolean>;
}

/** A redelivered event is answered once: the same message within this window says nothing more. */
const ANSWERED_TTL_MS = 10 * 60 * 1000;

const NO_DASHBOARD = ':information_source: 대시보드가 꺼져 있어 슬랙 세션으로 진행합니다.';
const RESTARTING = ':hourglass: 재시작 중이라 지금은 대시보드 작업을 시작할 수 없어요. 잠시 뒤 다시 지시해 주세요.';
const BUSY = ':hourglass: 다른 대시보드 작업이 진행 중이라 시작하지 않았어요 — 그 작업이 끝난 뒤 다시 지시해 주세요.';
/** D14: a fixed sentence in the channel; the store or folder error (it can carry a path) goes to the log only. */
const NOT_CREATED = ':warning: 작업을 만들지 못했어요 — 잠시 뒤 다시 지시해 주세요. 계속되면 관리자에게 알려 주세요.';

export function createSlackTaskEntry(deps: SlackTaskEntryDeps): SlackTaskEntry {
  const now = deps.now ?? Date.now;
  const answered = new Map<string, number>();

  /** First time this key is answered in the window. */
  function firstAnswer(key: string): boolean {
    const t = now();
    for (const [k, at] of answered) if (t - at > ANSWERED_TTL_MS) answered.delete(k);
    if (answered.has(key)) return false;
    answered.set(key, t);
    return true;
  }

  function linkText(task: ConversationSession): string {
    const url = task.taskId ? deps.cardUrl(task.ownerId, `task:${task.taskId}`) : undefined;
    return url ? ` <${url}|카드 열기>` : '';
  }

  async function guard(
    event: { channel: string; ts: string; thread_ts?: string; files?: unknown[] },
    say: Say,
  ): Promise<boolean> {
    const root = event.thread_ts ?? event.ts;
    const task = deps.getTaskByOriginThread(event.channel, root);
    if (!task?.originThread || !task.taskId) return false;
    const withFiles = (event.files?.length ?? 0) > 0;
    if (!firstAnswer(`${event.channel}:${event.ts}:${withFiles ? 'files' : 'text'}`)) return true;
    if (task.originThread.messageTs === event.ts) {
      // The instruction itself again: a redelivery says nothing — but its late
      // file_share copy carries files the task did not get (a task takes none).
      if (withFiles) {
        await say({
          text: `:paperclip: 첨부 파일은 대시보드 작업에 전달되지 않았어요 — 카드에서 이어서 지시해 주세요.${linkText(task)}`,
          thread_ts: root,
        });
      }
      return true;
    }
    await say({
      text: `:link: 이 스레드는 대시보드 작업에 연결돼 있어요 — 다음 지시는 카드에서 해 주세요.${linkText(task)}`,
      thread_ts: root,
    });
    return true;
  }

  async function run(input: {
    event: { user: string; channel: string; ts: string; thread_ts?: string; text?: string };
    say: Say;
    allow: TaskEntryAllowList;
  }): Promise<DispatchOutcome | undefined> {
    const { event, say, allow } = input;
    if (!isTaskEntryAllowed(allow) || !deps.isEnabled(event.user)) return undefined;
    const { channel, ts } = event;
    const root = event.thread_ts ?? ts;
    const text = (event.text ?? '').trim();
    const eyesOff = () => deps.reactions.remove(channel, ts, 'eyes').catch(() => undefined);

    const userName = await deps.getUserName(event.user);
    // The approval gate runs before anything is made for the user (D2 (4)).
    const gate = await deps.newUserGate({ user: event.user, userName, channel, threadTs: root });
    if (gate !== 'pass') {
      await eyesOff();
      return { result: 'blocked', reason: 'new user gate' };
    }
    // D12 — no dashboard, no surface to answer, approve or stop: the Slack path.
    if (!deps.isDashboardListening()) {
      await say({ text: NO_DASHBOARD, thread_ts: root });
      return undefined;
    }
    // D11 — refused before a folder or a task exists.
    const refused = deps.canStart(event.user, text);
    if (refused) {
      if (refused.status === 429 || refused.status === 503) {
        await say({ text: refusalText(refused), thread_ts: root });
        await eyesOff();
        return { result: 'safe' };
      }
      // A command shape the controller refuses: the Slack path takes it.
      return undefined;
    }

    let inputContext: TaskInputContext | undefined;
    try {
      inputContext = await deps.inputContext(channel);
    } catch (error) {
      deps.logger.warn('Task entry: the channel context could not be read — the task has none', {
        channel,
        error: (error as Error)?.message,
      });
    }

    let launched: TaskCommandResponse;
    try {
      launched = await deps.launch({
        ownerId: event.user,
        ownerName: userName,
        prompt: text,
        originThread: { channel, threadTs: root, messageTs: ts },
        ...(inputContext ? { inputContext } : {}),
      });
    } catch (error) {
      if ((error as Error)?.name === 'OriginThreadTakenError') {
        // Another task took this thread first. The guard answers as it would
        // have: silence when that task is this very mention (delivered twice
        // at once), the card link when it is an earlier one.
        await eyesOff();
        await guard({ channel, ts, thread_ts: root }, say);
        return { result: 'safe' };
      }
      const reason = (error as Error)?.message ?? String(error);
      deps.logger.error('Task entry: the task could not be made', { channel, ts, error: reason });
      await eyesOff();
      await deps.reactions.add(channel, ts, 'warning').catch(() => undefined);
      await say({ text: NOT_CREATED, thread_ts: root });
      return { result: 'error', reason: `task not created: ${reason}` };
    }

    if (launched.status !== 200) {
      // The launcher refused after the dry run (a race, or the folder).
      if (launched.status === 429 || launched.status === 503) {
        await say({ text: refusalText(launched), thread_ts: root });
        await eyesOff();
        return { result: 'safe' };
      }
      const reason = String(launched.body.error ?? `status ${launched.status}`);
      deps.logger.error('Task entry: the launcher refused the task', {
        channel,
        ts,
        status: launched.status,
        error: reason,
      });
      await eyesOff();
      await deps.reactions.add(channel, ts, 'warning').catch(() => undefined);
      await say({ text: NOT_CREATED, thread_ts: root });
      return { result: 'error', reason: `task not created: ${reason}` };
    }

    const sessionKey = String(launched.body.sessionKey ?? '');
    if (launched.body.status === 'not-started') {
      // Made, not started (a race): the thread is owed "not started" after its link.
      const session = deps.getTaskByKey(sessionKey);
      const reason = String(launched.body.reason ?? 'not started');
      if (!session) {
        deps.logger.warn('Task entry: made but not started, and the task is gone — no "not started" notice', {
          sessionKey,
          reason,
        });
      } else if (session.lastTurnOutcome) {
        // Its first chain already ended before its start (conversation not created): that end
        // owes the thread its own failure notice (E4 ⑤, D6 b) — not a second one (fable #701 R1).
        deps.logger.info('Task entry: made, and its first chain already ended — its own notice covers it', {
          sessionKey,
          reason,
        });
      } else {
        try {
          deps.notStarted(session, sessionKey, reason);
        } catch (error) {
          deps.logger.error('Task entry: the "not started" notice could not be recorded', {
            sessionKey,
            error: (error as Error)?.message,
          });
        }
      }
    }
    deps.logger.info('Slack instruction became a dashboard task', { channel, ts, sessionKey });
    await eyesOff();
    return { result: 'safe' };
  }

  return { run, guard };
}

/** 429 and 503 in the user's words — the controller's reasons are English log text (fable #671 P3-2). */
function refusalText(refused: TaskCommandResponse): string {
  return refused.status === 503 ? RESTARTING : BUSY;
}
