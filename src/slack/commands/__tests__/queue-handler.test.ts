import type { FollowupItem } from '@soma/slack/followup-queue';
import {
  FOLLOWUP_CANCEL_ACTION_ID,
  FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE,
  FOLLOWUP_RETRY_ACTION_ID,
  FOLLOWUP_SEND_NOW_ACTION_ID,
  FOLLOWUP_STEERED_LABEL,
} from '@soma/slack/followup-queue-blocks';
import { describe, expect, it, vi } from 'vitest';
import { CommandRouter } from '../command-router';
import { QueueHandler } from '../queue-handler';
import type { CommandContext } from '../types';

/**
 * `queue` / `큐` — the follow-up queue's read command (A40).
 *
 * What these pin: WHICH items it lists (unprocessed only), that each row keeps
 * the A39 controls, that a long backlog is summarised instead of truncated in
 * silence, that every posted row is registered for A41 deletion — and that the
 * router classifies it as a `control`, without which the command could not run
 * at the one moment it is useful (a turn is running, so the queue is non-empty).
 */

const SESSION_KEY = 'C1:111.222';
const CHANNEL = 'C1';
const THREAD_TS = '111.222';

function item(over: Partial<FollowupItem> = {}): FollowupItem {
  const seq = over.seq ?? 1;
  return {
    id: `${SESSION_KEY}#${seq}`,
    sessionKey: SESSION_KEY,
    seq,
    epoch: 3,
    state: 'queued',
    eventKey: `C1:1700.0001${seq}`,
    message: { user: 'U1', channel: CHANNEL, ts: `1700.0001${seq}`, text: `${seq}번 메시지` },
    context: { workingDirectory: '/tmp/work' },
    enqueuedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  } as FollowupItem;
}

function build(items: FollowupItem[], over: Record<string, any> = {}) {
  // A ts PER call: A41 deletes an item's own message, so two rows sharing one
  // ts would have the first processed item delete the second one's controls.
  let postCount = 0;
  const postSystemMessage = vi.fn().mockImplementation(async () => {
    postCount += 1;
    return { ts: `queue-ts-${postCount}`, channel: CHANNEL };
  });
  const rememberFollowupItemMessage = vi.fn();
  const handler = new QueueHandler({
    claudeHandler: { getSessionKey: (channel: string, threadTs: string) => `${channel}:${threadTs}` },
    slackApi: { postSystemMessage },
    getFollowupView: (sessionKey: string) =>
      sessionKey === SESSION_KEY ? { sessionKey, items, turnEpoch: 4 } : undefined,
    rememberFollowupItemMessage,
    ...over,
  });
  const say = vi.fn().mockResolvedValue({ ts: 'say-ts', channel: CHANNEL });
  const ctx: CommandContext = { user: 'U1', channel: CHANNEL, threadTs: THREAD_TS, text: 'queue', say };
  return { handler, ctx, postSystemMessage, rememberFollowupItemMessage, say };
}

/** Every post the command made, as `(text, blocks)` in order. */
function allPosts(postSystemMessage: ReturnType<typeof vi.fn>): Array<{ text: string; blocks: any[] }> {
  return postSystemMessage.mock.calls.map(([, text, options]: any[]) => ({
    text: String(text),
    blocks: (options?.blocks ?? []) as any[],
  }));
}

/** The `(text, blocks)` of the single post the command made. */
function posted(postSystemMessage: ReturnType<typeof vi.fn>): { text: string; blocks: any[] } {
  expect(postSystemMessage).toHaveBeenCalledTimes(1);
  return allPosts(postSystemMessage)[0];
}

/** Every section line across every posted message, in post order. */
function allSectionTexts(postSystemMessage: ReturnType<typeof vi.fn>): string[] {
  return allPosts(postSystemMessage).flatMap((post) => sectionTexts(post.blocks));
}

function sectionTexts(blocks: any[]): string[] {
  return blocks.filter((block) => block.type === 'section').map((block) => String(block.text?.text ?? ''));
}

function actionIds(blocks: any[]): string[] {
  return blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => (block.elements as any[]).map((element) => String(element.action_id)));
}

describe('QueueHandler.canHandle', () => {
  const handler = new QueueHandler();

  it('claims the two command words, slash-prefixed or not', () => {
    for (const text of ['queue', 'QUEUE', '/queue', '큐', '/큐', '  queue  ']) {
      expect(handler.canHandle(text)).toBe(true);
    }
  });

  it('leaves an argument-carrying message to the model', () => {
    // `queue`/`큐` with a remainder is ordinary language ("queue this for
    // later"), and answering-and-consuming it would eat the user's instruction.
    for (const text of ['queue this for later', '큐에 넣어줘', 'queued', 'q', '']) {
      expect(handler.canHandle(text)).toBe(false);
    }
  });
});

describe('QueueHandler.execute', () => {
  it('posts ONE message per pending row, each with its own controls', async () => {
    const { handler, ctx, postSystemMessage } = build([
      item({ seq: 1 }),
      item({ seq: 2, state: 'steered', stateReason: 'steered', steerUuid: 'u2' }),
      item({ seq: 3, state: 'failed' }),
    ]);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ handled: true });
    const posts = allPosts(postSystemMessage);
    expect(posts).toHaveLength(3);
    for (const call of postSystemMessage.mock.calls) {
      expect(call[0]).toBe(CHANNEL);
      expect(call[2].threadTs).toBe(THREAD_TS);
      // One row per message: a shared message could not be deleted per item.
      expect(sectionTexts(call[2].blocks)).toHaveLength(1);
    }
    expect(allSectionTexts(postSystemMessage)).toEqual([
      '1. 1번 메시지 · _queued_',
      `2. 2번 메시지 · _${FOLLOWUP_STEERED_LABEL}_`,
      '3. 3번 메시지 · _failed_',
    ]);
    // The controls follow each row's own state (M4), not one fixed pair.
    expect(actionIds(posts[0].blocks)).toEqual([FOLLOWUP_SEND_NOW_ACTION_ID, FOLLOWUP_CANCEL_ACTION_ID]);
    expect(actionIds(posts[1].blocks)).toEqual([FOLLOWUP_SEND_NOW_ACTION_ID, FOLLOWUP_CANCEL_ACTION_ID]);
    expect(actionIds(posts[2].blocks)).toEqual([FOLLOWUP_RETRY_ACTION_ID, FOLLOWUP_CANCEL_ACTION_ID]);
    // Each message's fallback is that item's own line, not a queue-wide count.
    expect(posts[0].text).toBe('Queue 1. 1번 메시지 · queued');
  });

  it('registers each row under its OWN ts so A41 deletes one row at a time', async () => {
    const { handler, ctx, rememberFollowupItemMessage } = build([item({ seq: 1 }), item({ seq: 2 })]);

    await handler.execute(ctx);

    expect(rememberFollowupItemMessage.mock.calls).toEqual([
      [`${SESSION_KEY}#1`, { channel: CHANNEL, ts: 'queue-ts-1' }],
      [`${SESSION_KEY}#2`, { channel: CHANNEL, ts: 'queue-ts-2' }],
    ]);
  });

  it('carries the freeze notice on a row the freeze parked, and only there', async () => {
    const { handler, ctx, postSystemMessage } = build([item({ seq: 1 }), item({ seq: 2, state: 'paused' })], {
      getFollowupView: (sessionKey: string) =>
        sessionKey === SESSION_KEY
          ? {
              sessionKey,
              items: [item({ seq: 1 }), item({ seq: 2, state: 'paused' })],
              turnEpoch: 4,
              freeze: { reason: 'process restart', at: 1 },
            }
          : undefined,
    });

    await handler.execute(ctx);

    const posts = allPosts(postSystemMessage);
    expect(JSON.stringify(posts[0].blocks)).not.toContain('재시작 전에 남아 있던 항목입니다');
    expect(JSON.stringify(posts[1].blocks)).toContain('재시작 전에 남아 있던 항목입니다');
  });

  it('lists only what is still waiting — history and in-flight rows are not', async () => {
    const { handler, ctx, postSystemMessage } = build([
      item({ seq: 1, state: 'resolved' }),
      item({ seq: 2, state: 'cancelled' }),
      item({ seq: 3, state: 'dispatched' }),
      item({ seq: 4, state: 'paused' }),
      item({ seq: 5, state: 'uncertain' }),
    ]);

    await handler.execute(ctx);

    const lines = allSectionTexts(postSystemMessage);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('1. 4번 메시지 · _paused_');
    expect(lines[1]).toContain('5번 메시지');
    expect(lines[1]).toContain('uncertain');
  });

  it('numbers the rows by LIST position, not by queue seq', async () => {
    // A gap ("1, 7, 12") would read as rows the command decided to hide.
    const { handler, ctx, postSystemMessage } = build([item({ seq: 7 }), item({ seq: 12 })]);

    await handler.execute(ctx);

    expect(allSectionTexts(postSystemMessage)).toEqual(['1. 7번 메시지 · _queued_', '2. 12번 메시지 · _queued_']);
  });

  it('says one line when nothing is waiting', async () => {
    const { handler, ctx, postSystemMessage, rememberFollowupItemMessage } = build([
      item({ seq: 1, state: 'resolved' }),
    ]);

    await handler.execute(ctx);

    const { text, blocks } = posted(postSystemMessage);
    expect(text).toBe('대기 중인 메시지가 없습니다');
    expect(blocks).toEqual([]);
    expect(postSystemMessage.mock.calls[0][2].blocks).toBeUndefined();
    expect(rememberFollowupItemMessage).not.toHaveBeenCalled();
  });

  it('says the same line when the thread has no queue at all', async () => {
    const { handler, ctx, postSystemMessage } = build([], { getFollowupView: () => undefined });

    await handler.execute(ctx);

    expect(posted(postSystemMessage).text).toBe('대기 중인 메시지가 없습니다');
  });

  it('shows one page of rows and counts the tail in a final message', async () => {
    const many = Array.from({ length: 13 }, (_, index) => item({ seq: index + 1 }));
    const { handler, ctx, postSystemMessage } = build(many);

    await handler.execute(ctx);

    const posts = allPosts(postSystemMessage);
    // Ten row messages + one tail message; the tail carries no controls, so a
    // row past the tenth is reached through its own item message instead.
    expect(posts).toHaveLength(FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE + 1);
    expect(allSectionTexts(postSystemMessage)).toHaveLength(FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE);
    expect(posts[posts.length - 1].text).toBe('…외 3건');
    expect(posts[posts.length - 1].blocks).toEqual([]);
    for (const post of posts) expect(post.blocks.length).toBeLessThanOrEqual(50);
  });

  it('registers every posted row for A41 deletion, and only the posted ones', async () => {
    const many = Array.from({ length: 11 }, (_, index) => item({ seq: index + 1 }));
    const { handler, ctx, rememberFollowupItemMessage } = build(many);

    await handler.execute(ctx);

    expect(rememberFollowupItemMessage).toHaveBeenCalledTimes(FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE);
    expect(rememberFollowupItemMessage.mock.calls[0]).toEqual([
      `${SESSION_KEY}#1`,
      { channel: CHANNEL, ts: 'queue-ts-1' },
    ]);
    // The 11th item got no message, so nothing here can delete for it.
    expect(rememberFollowupItemMessage.mock.calls.map((call: any[]) => call[0])).not.toContain(`${SESSION_KEY}#11`);
  });

  it('falls back to the channel of the request when Slack reports none', async () => {
    const { handler, ctx, rememberFollowupItemMessage } = build([item({ seq: 1 })], {
      slackApi: { postSystemMessage: vi.fn().mockResolvedValue({ ts: 'queue-ts' }) },
    });

    await handler.execute(ctx);

    expect(rememberFollowupItemMessage).toHaveBeenCalledWith(`${SESSION_KEY}#1`, {
      channel: CHANNEL,
      ts: 'queue-ts',
    });
  });

  it('answers through `say` when no slackApi is wired', async () => {
    const { handler, ctx, say } = build([item({ seq: 1 })], { slackApi: undefined });

    await handler.execute(ctx);

    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0][0].thread_ts).toBe(THREAD_TS);
    expect(sectionTexts(say.mock.calls[0][0].blocks)).toEqual(['1. 1번 메시지 · _queued_']);
  });

  it('answers instead of throwing when the host wired no queue view', async () => {
    const { handler, ctx, postSystemMessage } = build([], { getFollowupView: undefined, claudeHandler: undefined });

    await expect(handler.execute(ctx)).resolves.toEqual({ handled: true });
    expect(posted(postSystemMessage).text).toBe('대기 중인 메시지가 없습니다');
  });
});

/**
 * The classification is the load-bearing half of A40: a `queue` classified as an
 * `instruction` would be PARKED by the follow-up ingress while a turn runs
 * (`slack-handler.ts:isQueueableFollowup`) — i.e. the command to read the queue
 * would itself go into the queue. It is a `control` because the real handler
 * list claims it, so this asks the REAL router, not a stubbed handler set.
 */
describe('CommandRouter classification of `queue`', () => {
  const postSystemMessage = vi.fn().mockResolvedValue(undefined);
  const router = new CommandRouter({
    workingDirManager: { isGetCommand: () => false, parseSetCommand: () => null },
    mcpManager: { getPluginManager: vi.fn() },
    claudeHandler: { getSession: () => null, getSessionKey: (c: string, t: string) => `${c}:${t}` },
    sessionUiManager: {},
    requestCoordinator: { isRequestActive: () => false },
    slackApi: { postSystemMessage, getClient: vi.fn().mockReturnValue({}) },
    reactionManager: {},
    contextWindowManager: {},
    userSettingsStore: {},
  } as any);

  /**
   * Classification says the word is a control; only `route()` says the word
   * reaches THIS handler. A handler registered earlier that also claims `queue`
   * would answer something else entirely, and the classification test above
   * could not tell.
   */
  it('routes the word to the QueueHandler, which answers it', async () => {
    postSystemMessage.mockClear();
    const say = vi.fn().mockResolvedValue(undefined);

    const result = await router.route({ user: 'U1', channel: CHANNEL, threadTs: THREAD_TS, text: 'queue', say } as any);

    expect(result.handled).toBe(true);
    // No follow-up wiring on these deps, so the handler's own empty-queue line
    // is the fingerprint that it — and nothing else — answered.
    expect(postSystemMessage).toHaveBeenCalledWith(
      CHANNEL,
      QueueHandler.EMPTY_TEXT,
      expect.objectContaining({ threadTs: THREAD_TS }),
    );
  });

  it('runs live during a turn instead of being queued', () => {
    expect(router.classifyText('queue')).toBe('control');
    expect(router.classifyText('큐')).toBe('control');
    expect(router.classifyText('/queue')).toBe('control');
  });

  it('still queues a message that merely mentions the word', () => {
    expect(router.classifyText('큐에 있는거 다 처리해줘')).toBe('instruction');
    expect(router.classifyText('queue the deploy for later')).toBe('instruction');
  });
});
