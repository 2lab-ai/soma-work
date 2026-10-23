/**
 * Dashboard "New task" — the launcher (SSOT 2026-10-23 T2/T6/T7/T9).
 *
 * Turns a validated submission into a Slack thread in the chosen channel and a
 * session that runs as the requesting user:
 *
 *   1. post the root message (the instruction, verbatim) into the channel —
 *      everyone in the channel sees the task start there;
 *   2. upload the attachments into that thread (they become ordinary Slack
 *      files, which the message pipeline downloads like any user upload);
 *   3. hand the pipeline the user's message on that thread — NOT synthetic, so
 *      autogoal, autoskills and the `$autoz` force-fire behave exactly as for
 *      a message typed in Slack — with the per-task model / effort / autogoal;
 *   4. answer once the session exists (the turn keeps running in the
 *      background); every failure is posted into the thread.
 *
 * The root message is deliberately NOT marked as a bot-initiated thread
 * (`setBotThread`): for those the root IS the progress surface and gets
 * rewritten, which would erase the instruction from the channel. The surface
 * opens inside the thread instead, like for any user-started thread.
 *
 * Every Slack / pipeline effect is injected (`NewTaskLaunchDeps`); the
 * production wiring is in `src/index.ts`.
 */

import { Logger } from '../logger';
import {
  buildNewTaskRootMessage,
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
  routeContext: { skipAutoBotThread: true };
}

export type NewTaskSay = (args: any) => Promise<{ ts?: string }>;

export interface NewTaskLaunchDeps {
  postMessage(channel: string, text: string, blocks: unknown[]): Promise<{ ts?: string }>;
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
}

export interface NewTaskLaunchResult {
  channel: string;
  threadTs: string;
  sessionKey: string;
  permalink?: string;
  /** `running`: the session exists. `starting`: accepted, the session is not there yet. */
  status: 'running' | 'starting';
}

const POLL_MS = 100;
/** Thread / HTTP text never carries a raw error (tokens, URLs): the detail stays in the log. */
const FAILED_AFTER_START = '⚠️ 작업 실행 중 오류가 났습니다. 자세한 내용은 서버 로그에 남겼습니다.';

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

export async function launchNewTask(
  userId: string,
  submission: NewTaskSubmission,
  deps: NewTaskLaunchDeps,
): Promise<NewTaskLaunchResult> {
  const { channelId: channel } = submission;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const acceptTimeoutMs = deps.acceptTimeoutMs ?? 10_000;

  // 1. The visible start of the task in the channel.
  const root = buildNewTaskRootMessage({
    userId,
    prompt: submission.prompt,
    nickname: submission.nickname,
    effort: submission.effort,
    autogoal: submission.autogoal,
    autoz: submission.autoz,
    attachmentNames: submission.attachments.map((a) => a.name),
  });
  let rootTs: string | undefined;
  try {
    rootTs = (await deps.postMessage(channel, root.text, root.blocks))?.ts;
  } catch (error) {
    logger.error('New task: root message failed', { channel, userId, error: reason(error) });
  }
  if (!rootTs) throw new NewTaskError(502, 'Slack 채널에 작업 스레드를 만들지 못했습니다');

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
        return deps.postThreadNotice(channel, rootTs, FAILED_AFTER_START).catch(() => undefined);
      }
    });
  void run;

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
