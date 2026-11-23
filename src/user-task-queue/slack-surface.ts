/**
 * The per-user task queue's Slack side: the notices it posts and rewrites (`slack-notice.ts` builds them), and the
 * two buttons on the queued notice (먼저 진행 · 대기 취소).
 *
 * Every Slack call is best effort — a notice that fails is logged and never touches the queue. A notice's `ts` is
 * remembered on its entry; a rewrite that comes before the post finished waits for it.
 */
import type { App } from '@slack/bolt';
import { Logger } from '../logger';
import type { UserTaskEntry } from './ledger';
import {
  buildCancelledNotice,
  buildDeferredNotice,
  buildQueuedNotice,
  buildStartedNotice,
  type NoticeTask,
  parseQueueActionValue,
  USER_TASK_QUEUE_BYPASS_ACTION_ID,
  USER_TASK_QUEUE_CANCEL_ACTION_ID,
} from './slack-notice';
import type {
  QueueActionRefusal,
  QueueActionResult,
  RunningTask,
  UserTaskQueue,
  UserTaskQueueNotifier,
} from './user-task-queue';

export interface UserTaskSlackApi {
  postMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; blocks?: any[] },
  ): Promise<{ ts?: string; channel?: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: any[]): Promise<void>;
  getPermalink(channel: string, ts: string): Promise<string | null>;
  postEphemeral?(channel: string, user: string, text: string, threadTs?: string): Promise<unknown>;
}

export interface UserTaskSlackNotifierDeps {
  slackApi: UserTaskSlackApi;
  /** The queue (to remember notices, count the line). Read lazily: the notifier is built before the queue. */
  queue: () => Pick<UserTaskQueue, 'setNotice' | 'viewFor' | 'entry'> | undefined;
  /** A private channel (a DM, a private channel): its tasks are named in no other thread. */
  isPrivateChannel?(channel: string): boolean;
  logger?: Logger;
}

/** What a notice in another thread may say about a task: a private task's title and link stay in its own channel. */
export const PRIVATE_TASK_TITLE = '비공개 작업';

export function createUserTaskSlackNotifier(deps: UserTaskSlackNotifierDeps): UserTaskQueueNotifier {
  const logger = deps.logger ?? new Logger('UserTaskQueueSlack');
  /** Posts on their way, by entry: a rewrite waits for the post it rewrites. */
  const posting = new Map<string, Promise<{ channel: string; ts: string } | undefined>>();
  /** What a bypass stopped, by the entry that went first (named in its started notice). */
  const deferredBy = new Map<string, Promise<NoticeTask>>();

  const link = async (channel: string, threadTs: string): Promise<string | undefined> => {
    if (!channel || !threadTs) return undefined;
    try {
      return (await deps.slackApi.getPermalink(channel, threadTs)) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const hidden = (channel: string, inChannel: string) =>
    channel !== inChannel && (deps.isPrivateChannel?.(channel) ?? false);
  /** The task as a notice posted in `inChannel` names it. */
  const noticeTask = async (task: RunningTask, inChannel: string): Promise<NoticeTask> =>
    hidden(task.channel, inChannel)
      ? { title: PRIVATE_TASK_TITLE }
      : { title: task.title, link: await link(task.channel, task.threadTs) };
  const fail = (what: string) => (error: unknown) => {
    logger.warn(`User task queue: ${what} failed`, { error: (error as Error)?.message ?? String(error) });
    return undefined;
  };
  const noticeOf = async (entry: UserTaskEntry) => {
    const pending = posting.get(entry.id);
    if (pending) return pending;
    return deps.queue()?.entry(entry.id)?.notice ?? entry.notice;
  };
  const rewrite = (
    entry: UserTaskEntry,
    build: () => Promise<{ text: string; blocks: any[] }> | { text: string; blocks: any[] },
    what: string,
  ) => {
    void (async () => {
      const ref = await noticeOf(entry);
      posting.delete(entry.id);
      if (!ref) return;
      const notice = await build();
      await deps.slackApi.updateMessage(ref.channel, ref.ts, notice.text, notice.blocks);
    })().catch(fail(what));
  };
  const post = (channel: string, threadTs: string, notice: { text: string; blocks: any[] }, what: string) =>
    deps.slackApi.postMessage(channel, notice.text, { threadTs, blocks: notice.blocks }).catch(fail(what));

  return {
    queued(entry, ctx) {
      const job = (async () => {
        const running = await Promise.all(ctx.running.map((t) => noticeTask(t, entry.channel)));
        const waitingCount = deps
          .queue()
          ?.viewFor(entry.userId)
          .waiting.filter((w) => w.state === 'waiting').length;
        const notice = buildQueuedNotice({
          entryId: entry.id,
          position: ctx.position,
          limit: ctx.limit,
          running,
          waitingCount: waitingCount ?? ctx.position,
        });
        const posted = await deps.slackApi.postMessage(entry.channel, notice.text, {
          threadTs: entry.threadTs,
          blocks: notice.blocks,
        });
        if (!posted?.ts) return undefined;
        const ref = { channel: posted.channel || entry.channel, ts: posted.ts };
        deps.queue()?.setNotice(entry.id, ref);
        return ref;
      })().catch(fail('queued notice'));
      posting.set(entry.id, job);
    },
    started(entry, how) {
      if (entry.kind === 'resume') {
        void post(
          entry.channel,
          entry.threadTs,
          {
            text: '▶️ 먼저 진행한 작업이 끝나 이 작업을 이어서 합니다.',
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '▶️ *먼저 진행한 작업이 끝나 이 작업을 이어서 합니다.*' },
              },
            ],
          },
          'resume notice',
        );
        return;
      }
      const deferred = deferredBy.get(entry.id);
      deferredBy.delete(entry.id);
      rewrite(entry, async () => buildStartedNotice(how, deferred ? await deferred : undefined), 'started notice');
    },
    cancelled(entry) {
      if (entry.kind === 'resume') {
        void post(
          entry.channel,
          entry.threadTs,
          {
            text: '🚫 이어서 하기를 취소했습니다 — 이 작업은 멈춘 채로 둡니다.',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '🚫 *이어서 하기를 취소했습니다* — 이 작업은 멈춘 채로 둡니다. 이어서 하려면 메시지를 보내세요.',
                },
              },
            ],
          },
          'resume cancel notice',
        );
        return;
      }
      rewrite(entry, () => buildCancelledNotice(), 'cancelled notice');
    },
    deferred(victim, first) {
      // Named in the first one's notice (its rewrite waits for this); the first one named in the stopped thread —
      // neither leaks a private task.
      deferredBy.set(first.id, noticeTask(victim, first.channel));
      void (async () => {
        const firstTask = hidden(first.channel, victim.channel)
          ? { title: PRIVATE_TASK_TITLE }
          : { title: first.preview, link: await link(first.channel, first.threadTs) };
        await post(victim.channel, victim.threadTs, buildDeferredNotice(firstTask), 'deferred notice');
      })().catch(fail('deferred notice'));
    },
  };
}

const REFUSAL_TEXT: Record<QueueActionRefusal, string> = {
  'not-found': '이 대기 항목은 이미 없습니다 — 시작됐거나 취소됐습니다.',
  'not-waiting': '이 작업은 이미 시작됐습니다.',
  forbidden: '이 작업을 요청한 사람(또는 관리자)만 조작할 수 있습니다.',
};

export interface UserTaskQueueActionDeps {
  queue: () => Pick<UserTaskQueue, 'bypass' | 'cancel'> | undefined;
  isAdmin: (userId: string) => boolean;
  slackApi: Pick<UserTaskSlackApi, 'postEphemeral'>;
  logger?: Logger;
}

/** One click on a queued notice's button. Exported for tests; `registerUserTaskQueueActions` wires it. */
export async function handleUserTaskQueueAction(
  kind: 'bypass' | 'cancel',
  body: any,
  deps: UserTaskQueueActionDeps,
): Promise<QueueActionResult | undefined> {
  const entryId = parseQueueActionValue(body?.actions?.[0]?.value);
  const clicker: string | undefined = body?.user?.id;
  const queue = deps.queue();
  if (!entryId || !clicker || !queue) return undefined;
  const admin = deps.isAdmin(clicker);
  const result =
    kind === 'bypass' ? queue.bypass(entryId, clicker, { admin }) : queue.cancel(entryId, clicker, { admin });
  if (!result.ok) {
    const channel = body?.channel?.id ?? body?.container?.channel_id;
    const threadTs = body?.message?.thread_ts ?? body?.container?.thread_ts;
    if (channel) {
      try {
        await deps.slackApi.postEphemeral?.(channel, clicker, REFUSAL_TEXT[result.reason], threadTs);
      } catch {
        // The refusal is a courtesy: the click did nothing either way.
      }
    }
  }
  return result;
}

export function registerUserTaskQueueActions(app: App, deps: UserTaskQueueActionDeps): void {
  const logger = deps.logger ?? new Logger('UserTaskQueueActions');
  for (const [actionId, kind] of [
    [USER_TASK_QUEUE_BYPASS_ACTION_ID, 'bypass'],
    [USER_TASK_QUEUE_CANCEL_ACTION_ID, 'cancel'],
  ] as const) {
    app.action(actionId, async ({ ack, body }) => {
      await ack();
      try {
        const result = await handleUserTaskQueueAction(kind, body, deps);
        logger.info('User task queue: button', {
          kind,
          ok: result?.ok,
          reason: result && !result.ok ? result.reason : undefined,
        });
      } catch (error) {
        logger.warn('User task queue: button failed', { kind, error: (error as Error)?.message ?? String(error) });
      }
    });
  }
}
