import type { FollowupItem } from '@soma/slack/followup-queue';
import { FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE, FOLLOWUP_STEERED_LABEL } from '@soma/slack/followup-queue-blocks';
import { describe, expect, it, vi } from 'vitest';
import { CommandRouter } from '../command-router';
import { QueueHandler } from '../queue-handler';
import type { CommandContext } from '../types';

/**
 * `queue` / `큐` — the follow-up queue's read command (A40).
 *
 * What these pin: WHICH items it lists (unprocessed only), that a row is TEXT
 * (09 — the controls are reactions on the user's own message, so a listing that
 * carried buttons would be a second, untracked copy of them), that a long
 * backlog is summarised instead of truncated in silence — and that the router
 * classifies it as a `control`, without which the command could not run at the
 * one moment it is useful (a turn is running, so the queue is non-empty).
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
  let postCount = 0;
  const postSystemMessage = vi.fn().mockImplementation(async () => {
    postCount += 1;
    return { ts: `queue-ts-${postCount}`, channel: CHANNEL };
  });
  const handler = new QueueHandler({
    claudeHandler: { getSessionKey: (channel: string, threadTs: string) => `${channel}:${threadTs}` },
    slackApi: { postSystemMessage },
    getFollowupView: (sessionKey: string) =>
      sessionKey === SESSION_KEY ? { sessionKey, items, turnEpoch: 4 } : undefined,
    ...over,
  });
  const say = vi.fn().mockResolvedValue({ ts: 'say-ts', channel: CHANNEL });
  const ctx: CommandContext = { user: 'U1', channel: CHANNEL, threadTs: THREAD_TS, text: 'queue', say };
  return { handler, ctx, postSystemMessage, say };
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

/** Every context line across every posted message, in post order. */
function allContextTexts(postSystemMessage: ReturnType<typeof vi.fn>): string[] {
  return allPosts(postSystemMessage).flatMap((post) =>
    post.blocks
      .filter((block) => block.type === 'context')
      .flatMap((block) => (block.elements as any[]).map((element) => String(element.text ?? ''))),
  );
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
  it('posts ONE message per pending row, each reading as the item it is', async () => {
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
      // One row per message, same as before — a listing that packed every row
      // into one message could not say which line is which item's.
      expect(sectionTexts(call[2].blocks)).toHaveLength(1);
    }
    expect(allSectionTexts(postSystemMessage)).toEqual([
      '1. 1번 메시지 · _queued_',
      `2. 2번 메시지 · _${FOLLOWUP_STEERED_LABEL}_`,
      '3. 3번 메시지 · _failed_',
    ]);
    // Each message's fallback is that item's own line, not a queue-wide count.
    expect(posts[0].text).toBe('Queue 1. 1번 메시지 · queued');
  });

  /**
   * 09 — the controls are reactions on the user's own message. A listing that
   * rendered its own `Send now`/`Cancel` would be a SECOND copy of them, on a
   * message nothing takes down when the item settles: the stale-button surface
   * the reaction UI exists to remove.
   */
  it('carries no buttons at all — the controls are on the user message', async () => {
    const { handler, ctx, postSystemMessage } = build([
      item({ seq: 1 }),
      item({ seq: 2, state: 'paused' }),
      item({ seq: 3, state: 'failed' }),
    ]);

    await handler.execute(ctx);

    for (const post of allPosts(postSystemMessage)) {
      expect(post.blocks.some((block) => block.type === 'actions')).toBe(false);
      expect(JSON.stringify(post.blocks)).not.toContain('action_id');
    }
  });

  /**
   * …and where the controls ARE is said out loud, naming the operation that
   * state actually has (09 C1): a waiting row runs early or drops, a `failed`/
   * `uncertain` one re-runs or drops, and a `steered` row — whose controls came
   * down — is told nothing at all.
   */
  it('points at the reactions on the rows that offer them, naming the right operation', async () => {
    const { handler, ctx, postSystemMessage } = build([
      item({ seq: 1 }),
      item({ seq: 2, state: 'paused' }),
      item({ seq: 3, state: 'failed' }),
      item({ seq: 4, state: 'steered' }),
      item({ seq: 5, state: 'uncertain' }),
    ]);

    await handler.execute(ctx);

    const posts = allPosts(postSystemMessage);
    expect(JSON.stringify(posts[0].blocks)).toContain(QueueHandler.REACTION_HINT);
    expect(JSON.stringify(posts[1].blocks)).toContain(QueueHandler.REACTION_HINT);
    expect(JSON.stringify(posts[2].blocks)).toContain(QueueHandler.REACTION_RETRY_HINT);
    expect(JSON.stringify(posts[3].blocks)).not.toContain('리액션으로');
    expect(JSON.stringify(posts[4].blocks)).toContain(QueueHandler.REACTION_RETRY_HINT);
    // …and the two wordings are never mixed up on one row.
    expect(JSON.stringify(posts[2].blocks)).not.toContain(QueueHandler.REACTION_HINT);
    expect(JSON.stringify(posts[0].blocks)).not.toContain(QueueHandler.REACTION_RETRY_HINT);
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
    // The freeze notice and the reaction hint are two different facts on the
    // same parked row, and both are context lines.
    expect(allContextTexts(postSystemMessage)).toContain(QueueHandler.REACTION_HINT);
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
    const { handler, ctx, postSystemMessage } = build([item({ seq: 1, state: 'resolved' })]);

    await handler.execute(ctx);

    const { text, blocks } = posted(postSystemMessage);
    expect(text).toBe('대기 중인 메시지가 없습니다');
    expect(blocks).toEqual([]);
    expect(postSystemMessage.mock.calls[0][2].blocks).toBeUndefined();
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
    // Ten row messages + one tail message; a row past the tenth is read on its
    // own message, where its reactions are.
    expect(posts).toHaveLength(FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE + 1);
    expect(allSectionTexts(postSystemMessage)).toHaveLength(FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE);
    expect(posts[posts.length - 1].text).toBe('…외 3건');
    expect(posts[posts.length - 1].blocks).toEqual([]);
    for (const post of posts) expect(post.blocks.length).toBeLessThanOrEqual(50);
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
