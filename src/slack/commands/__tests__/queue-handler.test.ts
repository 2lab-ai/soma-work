import type { FollowupItem } from '@soma/slack/followup-queue';
import {
  FOLLOWUP_CANCEL_ACTION_ID,
  FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE,
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
  const postSystemMessage = vi.fn().mockResolvedValue({ ts: 'queue-ts', channel: CHANNEL });
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

/** The `(text, options)` of the single post the command made. */
function posted(postSystemMessage: ReturnType<typeof vi.fn>): { text: string; blocks: any[] } {
  expect(postSystemMessage).toHaveBeenCalledTimes(1);
  const [, text, options] = postSystemMessage.mock.calls[0];
  return { text: String(text), blocks: (options?.blocks ?? []) as any[] };
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
  it('lists the unprocessed items with both controls on every row', async () => {
    const { handler, ctx, postSystemMessage } = build([
      item({ seq: 1 }),
      item({ seq: 2, state: 'steered', stateReason: 'steered', steerUuid: 'u2' }),
      item({ seq: 3, state: 'failed' }),
    ]);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ handled: true });
    const { text, blocks } = posted(postSystemMessage);
    expect(postSystemMessage.mock.calls[0][0]).toBe(CHANNEL);
    expect(postSystemMessage.mock.calls[0][2].threadTs).toBe(THREAD_TS);
    expect(sectionTexts(blocks)).toEqual([
      '1. 1번 메시지 · _queued_',
      `2. 2번 메시지 · _${FOLLOWUP_STEERED_LABEL}_`,
      '3. 3번 메시지 · _failed_',
    ]);
    expect(actionIds(blocks)).toEqual([
      FOLLOWUP_SEND_NOW_ACTION_ID,
      FOLLOWUP_CANCEL_ACTION_ID,
      FOLLOWUP_SEND_NOW_ACTION_ID,
      FOLLOWUP_CANCEL_ACTION_ID,
      FOLLOWUP_SEND_NOW_ACTION_ID,
      FOLLOWUP_CANCEL_ACTION_ID,
    ]);
    // Counts only in the fallback — the rows carry the (escaped) text.
    expect(text).toBe('Queue — 대기 3건');
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

    const { blocks } = posted(postSystemMessage);
    const lines = sectionTexts(blocks);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('1. 4번 메시지 · _paused_');
    expect(lines[1]).toContain('5번 메시지');
    expect(lines[1]).toContain('uncertain');
  });

  it('numbers the rows by LIST position, not by queue seq', async () => {
    // A gap ("1, 7, 12") would read as rows the command decided to hide.
    const { handler, ctx, postSystemMessage } = build([item({ seq: 7 }), item({ seq: 12 })]);

    await handler.execute(ctx);

    expect(sectionTexts(posted(postSystemMessage).blocks)).toEqual([
      '1. 7번 메시지 · _queued_',
      '2. 12번 메시지 · _queued_',
    ]);
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

  it('shows one page and counts the tail instead of dropping it', async () => {
    const many = Array.from({ length: 13 }, (_, index) => item({ seq: index + 1 }));
    const { handler, ctx, postSystemMessage } = build(many);

    await handler.execute(ctx);

    const { text, blocks } = posted(postSystemMessage);
    expect(sectionTexts(blocks)).toHaveLength(FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE);
    expect(blocks[blocks.length - 1]).toEqual({
      type: 'context',
      elements: [{ type: 'plain_text', text: '…외 3건' }],
    });
    // Slack caps a message at 50 blocks; a full page is 10 rows × 2 + the tail.
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(text).toBe('Queue — 대기 13건');
  });

  it('registers every posted row for A41 deletion, and only the posted ones', async () => {
    const many = Array.from({ length: 11 }, (_, index) => item({ seq: index + 1 }));
    const { handler, ctx, rememberFollowupItemMessage } = build(many);

    await handler.execute(ctx);

    expect(rememberFollowupItemMessage).toHaveBeenCalledTimes(FOLLOWUP_QUEUE_DEFAULT_PAGE_SIZE);
    expect(rememberFollowupItemMessage.mock.calls[0]).toEqual([
      `${SESSION_KEY}#1`,
      { channel: CHANNEL, ts: 'queue-ts' },
    ]);
    // The 11th item is not on this message, so nothing here can delete for it.
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
  const router = new CommandRouter({
    workingDirManager: { isGetCommand: () => false, parseSetCommand: () => null },
    mcpManager: { getPluginManager: vi.fn() },
    claudeHandler: { getSession: () => null, getSessionKey: (c: string, t: string) => `${c}:${t}` },
    sessionUiManager: {},
    requestCoordinator: { isRequestActive: () => false },
    slackApi: { postSystemMessage: vi.fn(), getClient: vi.fn().mockReturnValue({}) },
    reactionManager: {},
    contextWindowManager: {},
    userSettingsStore: {},
  } as any);

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
