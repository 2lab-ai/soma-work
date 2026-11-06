/**
 * Dashboard "New task" — the launcher (SSOT 2026-10-23 T2/T6/T7/T9).
 *
 * Turns a validated submission into a Slack thread in the chosen channel and a
 * session that runs as the requesting user — the same thread a task started in
 * Slack gets:
 *
 *   1. post the thread header (ThreadHeaderBuilder) as the channel root —
 *      everyone in the channel sees the task start there, and the session's
 *      panel IS that root, updated in place (the bot-thread migration's model);
 *   2. post the instruction, verbatim, as the thread's first reply;
 *   3. upload the attachments into that thread (they become ordinary Slack
 *      files, which the message pipeline downloads like any user upload);
 *   4. hand the pipeline the user's message on that thread — NOT synthetic, so
 *      autogoal, autoskills and the `$autoz` force-fire behave exactly as for
 *      a message typed in Slack — with the per-task model / effort / autogoal,
 *      and `botThreadRoot`, so the new session is bot-initiated on the header;
 *   5. answer once the session exists (the turn keeps running in the
 *      background); every failure is posted into the thread.
 *
 * A command that only answers (`submission.answerOnly`) creates no session to
 * keep a header current: its instruction stays the root, as before.
 *
 * Every Slack / pipeline effect is injected (`NewTaskLaunchDeps`); the
 * production wiring is in `src/index.ts`.
 */

import { Logger } from '../logger';
import { MessageFormatter } from '../slack/message-formatter';
import { type SessionTheme, ThreadHeaderBuilder } from '../slack/thread-header-builder';
import {
  buildNewTaskInstructionMessage,
  composeTaskText,
  type NewTaskAttachment,
  NewTaskError,
  type NewTaskSubmission,
} from './new-task';

export { NewTaskError } from './new-task';

const logger = new Logger('DashboardNewTask');

/** A Slack file as the message pipeline expects it on `event.files`. */
export interface SlackEventFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  url_private: string;
  url_private_download: string;
  size: number;
  /** Slack permalink — the dashboard's only way to open a file the bot does not download (video, untranscribed audio). */
  permalink?: string;
}

/** A file read back from Slack (`files.info`), in the shape the message pipeline downloads from. */
// biome-ignore lint/suspicious/noExplicitAny: files.info returns an untyped Slack file object
export function slackEventFileFrom(id: string, info: any): SlackEventFile {
  const permalink =
    typeof info?.permalink === 'string' && /^https:\/\//i.test(info.permalink) ? info.permalink : undefined;
  return {
    id,
    name: info?.name ?? id,
    mimetype: info?.mimetype ?? 'application/octet-stream',
    filetype: info?.filetype ?? '',
    url_private: info?.url_private ?? info?.url_private_download,
    url_private_download: info?.url_private_download,
    size: typeof info?.size === 'number' ? info.size : 0,
    ...(permalink ? { permalink } : {}),
  };
}

/** The message event a dashboard task enters the pipeline with. */
export interface NewTaskEvent {
  type: 'message';
  user: string;
  channel: string;
  thread_ts: string;
  ts: string;
  text: string;
  files?: SlackEventFile[];
  modelOverride: string;
  effortOverride: string;
  autoGoalOverride: boolean;
  /** #853 — the plan switch: the session plans before it works. */
  planModeOverride?: true;
  /** #854 — the epic switch: the new session is an epic. */
  epicOverride?: true;
  /** The thread root is the task's header: the new session is bot-initiated on it (absent for answer-only). */
  botThreadRoot?: true;
  routeContext: { skipAutoBotThread: true };
}

export type NewTaskSay = (args: any) => Promise<{ ts?: string }>;

export interface NewTaskLaunchDeps {
  /** A channel root, or a reply when `threadTs` is given. */
  postMessage(channel: string, text: string, blocks: unknown[], threadTs?: string): Promise<{ ts?: string }>;
  /** The owner's display name for the header (the session re-renders it with its own once it runs). */
  getUserName?(userId: string): Promise<string | undefined>;
  /** The owner's thread header theme; absent = the server's. */
  getSessionTheme?(userId: string): SessionTheme | undefined;
  uploadFiles(channel: string, threadTs: string, files: NewTaskAttachment[]): Promise<SlackEventFile[]>;
  postThreadNotice(channel: string, threadTs: string, text: string): Promise<unknown>;
  getPermalink(channel: string, ts: string): Promise<string | undefined>;
  getSessionKey(channel: string, threadTs: string): string;
  hasSession(sessionKey: string): boolean;
  handleMessage(event: NewTaskEvent, say: NewTaskSay): Promise<unknown>;
  makeSay(channel: string, threadTs: string): NewTaskSay;
  sleep?(ms: number): Promise<void>;
  /** How long to wait for the session to exist before answering `starting`. */
  acceptTimeoutMs?: number;
  /** How long the instruction reply is waited for before the task runs anyway (default 10 s). */
  replyTimeoutMs?: number;
}

export interface NewTaskLaunchResult {
  channel: string;
  threadTs: string;
  sessionKey: string;
  permalink?: string;
  /**
   * `running`: the session exists. `starting`: accepted, the session is not there yet. `answered`: an answer-only
   * first message (`submission.answerOnly`) was handled — its answer is in the thread, and no session comes.
   */
  status: 'running' | 'starting' | 'answered';
  /** `answered` only: the command was handled before the launch answered (false: its answer is still on its way). */
  handled?: boolean;
}

const POLL_MS = 100;
/** Thread / HTTP text never carries a raw error (tokens, URLs): the detail stays in the log. */
const FAILED_AFTER_START = '⚠️ 작업 실행 중 오류가 났습니다. 자세한 내용은 서버 로그에 남겼습니다.';
/** An answer-only command that failed — its words, not a task's (it is no task). */
const COMMAND_FAILED = '⚠️ 명령을 처리하지 못했습니다. 대시보드에서 다시 시도해 주세요.';

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * Wait for a best-effort post at most `ms` (#955 review, astra P2): Slack's client has no request
 * timeout and retries rate limits, so an unbounded wait on an optional reply would hold back the
 * work it precedes. Never throws; the post may still land after the wait ends.
 */
function settleWithin(post: Promise<unknown>, ms: number): Promise<{ failed?: unknown; timedOut?: true }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
    post.then(
      () => {
        clearTimeout(timer);
        resolve({});
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ failed: error });
      },
    );
  });
}

/**
 * The task's thread header before its session exists: titled from the instruction (the dispatch
 * gives the session its own title, and the first render rewrites the header with it).
 */
async function taskHeader(
  userId: string,
  prompt: string,
  deps: NewTaskLaunchDeps,
): Promise<{ text: string; blocks: unknown[] }> {
  let ownerName: string | undefined;
  try {
    ownerName = (await deps.getUserName?.(userId)) || undefined;
  } catch (error) {
    logger.warn('New task: owner name unavailable for the header', { userId, error: reason(error) });
  }
  const generated = prompt ? MessageFormatter.generateSessionTitle(prompt) : '';
  const title = !generated || generated === '[link]' || generated === '새 대화' ? undefined : generated;
  const header = ThreadHeaderBuilder.build({
    title,
    workflow: 'default',
    ownerId: userId,
    ownerName,
    theme: deps.getSessionTheme?.(userId),
  });
  return { text: header.text, blocks: header.blocks ?? [] };
}

export async function launchNewTask(
  userId: string,
  submission: NewTaskSubmission,
  deps: NewTaskLaunchDeps,
): Promise<NewTaskLaunchResult> {
  const { channelId: channel } = submission;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const acceptTimeoutMs = deps.acceptTimeoutMs ?? 10_000;

  // 1. The visible start of the task in the channel: the thread header a Slack-started task gets
  //    (its panel), with the instruction as the first reply — or, for an answer-only command, the
  //    instruction itself (no session comes to keep a header current).
  const instruction = buildNewTaskInstructionMessage({
    userId,
    prompt: submission.prompt,
    nickname: submission.nickname,
    effort: submission.effort,
    autogoal: submission.autogoal,
    autoz: submission.autoz,
    plan: submission.plan === true,
    epic: submission.epic === true,
    attachmentNames: submission.attachments.map((a) => a.name),
  });
  const onHeader = submission.answerOnly !== true;
  const root = onHeader ? await taskHeader(userId, submission.prompt, deps) : instruction;
  let rootTs: string | undefined;
  try {
    rootTs = (await deps.postMessage(channel, root.text, root.blocks))?.ts;
  } catch (error) {
    logger.error('New task: root message failed', { channel, userId, error: reason(error) });
  }
  if (!rootTs) throw new NewTaskError(502, 'Slack 채널에 작업 스레드를 만들지 못했습니다');
  if (onHeader) {
    // The task runs without its echo (the session gets the instruction, the dashboard shows it) —
    // and does not wait on it for long.
    const replyTimeoutMs = deps.replyTimeoutMs ?? 10_000;
    const echo = await settleWithin(
      Promise.resolve().then(() => deps.postMessage(channel, instruction.text, instruction.blocks, rootTs)),
      replyTimeoutMs,
    );
    if (echo.failed !== undefined) {
      logger.warn('New task: instruction reply failed', { channel, rootTs, userId, error: reason(echo.failed) });
    } else if (echo.timedOut) {
      logger.warn('New task: instruction reply still posting — the task runs without waiting', {
        channel,
        rootTs,
        userId,
        waitedMs: replyTimeoutMs,
      });
    }
  }

  // 2. Attachments into the thread. A partial task is worse than none: stop and say so.
  let files: SlackEventFile[] = [];
  if (submission.attachments.length > 0) {
    try {
      files = await deps.uploadFiles(channel, rootTs, submission.attachments);
    } catch (error) {
      logger.error('New task: attachment upload failed', { channel, rootTs, userId, error: reason(error) });
      await deps
        .postThreadNotice(
          channel,
          rootTs,
          '⚠️ 첨부 파일 업로드에 실패해 작업을 시작하지 않았습니다. 대시보드에서 다시 시도해 주세요.',
        )
        .catch(() => undefined);
      throw new NewTaskError(502, '첨부 파일을 Slack에 올리지 못했습니다 — 작업을 시작하지 않았습니다');
    }
  }

  // 3. The user's own message on that thread.
  const event: NewTaskEvent = {
    type: 'message',
    user: userId,
    channel,
    thread_ts: rootTs,
    ts: rootTs,
    text: composeTaskText(submission.prompt, submission.autoz),
    modelOverride: submission.model,
    effortOverride: submission.effort,
    autoGoalOverride: submission.autogoal,
    ...(submission.plan === true ? { planModeOverride: true as const } : {}),
    ...(submission.epic === true ? { epicOverride: true as const } : {}),
    ...(onHeader ? { botThreadRoot: true as const } : {}),
    routeContext: { skipAutoBotThread: true },
  };
  if (files.length > 0) event.files = files;
  const sessionKey = deps.getSessionKey(channel, rootTs);

  let failure: { error: unknown } | undefined;
  let accepted = false;
  const run = Promise.resolve()
    .then(() => deps.handleMessage(event, deps.makeSay(channel, rootTs)))
    .catch((error: unknown) => {
      failure = { error };
      logger.error('New task: pipeline failed', { channel, rootTs, userId, error: reason(error) });
      // Before acceptance the HTTP caller hears it; after, only the thread can.
      if (accepted) {
        const notice = submission.answerOnly === true ? COMMAND_FAILED : FAILED_AFTER_START;
        return deps.postThreadNotice(channel, rootTs, notice).catch(() => undefined);
      }
    });
  void run;

  // 4a. A command that only answers: wait for it to be handled (no session comes), then say where the answer is.
  if (submission.answerOnly === true) {
    let handled = false;
    void run.then(() => {
      handled = true;
    });
    const until = Date.now() + acceptTimeoutMs;
    let rounds = Math.ceil(acceptTimeoutMs / POLL_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (!handled && rounds-- > 0 && Date.now() <= until) {
      await sleep(POLL_MS);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (failure) {
      await deps.postThreadNotice(channel, rootTs, COMMAND_FAILED).catch(() => undefined);
      throw new NewTaskError(500, '명령을 처리하지 못했습니다 — 잠시 후 다시 시도해 주세요');
    }
    // Still being handled when the wait ended (a slow command): the launch says so (`handled: false` — its answer is
    // on its way, not there yet); a failure after this point is said in the thread (COMMAND_FAILED).
    accepted = true;
    let answeredLink: string | undefined;
    try {
      answeredLink = await deps.getPermalink(channel, rootTs);
    } catch {
      answeredLink = undefined;
    }
    logger.info('New task: answer-only command from the dashboard', { channel, rootTs, userId, handled });
    const answered: NewTaskLaunchResult = { channel, threadTs: rootTs, sessionKey, status: 'answered', handled };
    if (answeredLink) answered.permalink = answeredLink;
    return answered;
  }

  // 4. Answer once the session exists, the pipeline failed, or the wait ran out.
  const deadline = Date.now() + acceptTimeoutMs;
  let polls = Math.ceil(acceptTimeoutMs / POLL_MS);
  // Let the pipeline's first synchronous steps (session creation, an early throw) settle.
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
  while (!failure && !deps.hasSession(sessionKey) && polls-- > 0 && Date.now() <= deadline) {
    await sleep(POLL_MS);
    await settle();
  }
  if (failure && !deps.hasSession(sessionKey)) {
    await deps
      .postThreadNotice(channel, rootTs, '⚠️ 작업을 시작하지 못했습니다. 대시보드에서 다시 시도해 주세요.')
      .catch(() => undefined);
    throw new NewTaskError(500, '작업을 시작하지 못했습니다 — 잠시 후 다시 시도해 주세요');
  }
  accepted = true;
  if (failure) {
    // Failed after the session appeared but before we answered: still say it in the thread.
    await deps.postThreadNotice(channel, rootTs, FAILED_AFTER_START).catch(() => undefined);
  }

  let permalink: string | undefined;
  try {
    permalink = await deps.getPermalink(channel, rootTs);
  } catch {
    permalink = undefined;
  }
  const status = deps.hasSession(sessionKey) ? 'running' : 'starting';
  logger.info('New task: launched from the dashboard', { channel, rootTs, userId, status, files: files.length });
  const result: NewTaskLaunchResult = { channel, threadTs: rootTs, sessionKey, status };
  if (permalink) result.permalink = permalink;
  return result;
}
