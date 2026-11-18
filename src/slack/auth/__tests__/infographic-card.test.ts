/**
 * `auth` card × infographic (2026-11-18): every entry point that shows the card —
 * naked `auth`, the `/z auth` topic, every card button — leads with the summary
 * picture; the per-account detail moves to [📋 계정별 리포트], posted in the thread.
 * When the picture cannot be made or Slack refuses it, the text card still arrives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../commands/types';

vi.mock('../../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));
vi.mock('../../../auth/auth-runtime', () => ({
  getAuthRuntimeSnapshot: () => ({ mode: 'llmux', llmux: { baseUrl: 'http://localhost:3456', apiKey: 'test-secret' } }),
  getAuthMode: () => 'llmux',
  setAuthMode: vi.fn(),
  setLlmuxSettings: vi.fn(),
}));
vi.mock('../../../auth/llmux-tenant-keys', () => ({ describeTenantKey: vi.fn(), ensureTenantKey: vi.fn() }));
vi.mock('../../z/topics/cct-topic', () => ({ renderCctCard: vi.fn() }));
vi.mock('../../../auth/llmux-client', () => ({
  fetchLlmuxStatus: vi.fn(async () => ({
    current: 'claude:ai1@x',
    version: 'llmux 0.2.26',
    accounts: Array.from({ length: 10 }, (_, i) => ({
      name: `claude:ai${i + 1}@x`,
      type: 'oauth',
      group: 'claude',
      status: 'ok',
      order: i + 1,
      seven_day: { utilization: 0.5, resets_at: Math.floor(Date.now() / 1000) + 86400, resets_in_secs: 86400 },
    })),
  })),
  switchLlmuxAccount: vi.fn(),
  addLlmuxAccount: vi.fn(),
  removeLlmuxAccount: vi.fn(),
  isLlmuxUp: vi.fn(),
  LlmuxClientError: class extends Error {},
}));
vi.mock('../infographic-publish', () => ({
  renderAuthSummaryPng: vi.fn(async () => Buffer.from('summary-png')),
  renderAuthReportPng: vi.fn(async () => Buffer.from('report-png')),
}));

import { AuthHandler } from '../../commands/auth-handler';
import { createAuthTopicBinding, renderAuthCard } from '../../z/topics/auth-topic';
import { registerAuthActions } from '../actions';
import { renderAuthReportPng, renderAuthSummaryPng } from '../infographic-publish';
import { AUTH_ACTION_IDS } from '../views';

type Block = Record<string, unknown>;
type Card = { text?: string; blocks: Block[]; fallbackBlocks?: Block[] };

const invalidBlocks = () => Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } });
const imageOf = (blocks: Block[]) =>
  blocks.find((b) => b.type === 'image') as { slack_file: { id: string }; alt_text: string } | undefined;
const str = (blocks: unknown) => JSON.stringify(blocks);

function slackClient(over: { postMessage?: (msg: Block) => Promise<unknown>; upload?: () => Promise<unknown> } = {}) {
  let n = 0;
  return {
    filesUploadV2: vi.fn(over.upload ?? (async () => ({ files: [{ files: [{ id: `F${++n}` }] }] }))),
    chat: {
      update: vi.fn(async () => ({ ok: true })),
      postMessage: vi.fn(over.postMessage ?? (async () => ({ ok: true, ts: '333.444' }))),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('renderAuthCard with an image uploader', () => {
  it('leads with the summary picture and keeps the text card as the fallback', async () => {
    const upload = vi.fn(async () => 'F_SUMMARY');
    const card = (await renderAuthCard({ userId: 'U_PLAIN', issuedAt: Date.now(), uploadImage: upload })) as Card;
    expect(upload).toHaveBeenCalledWith(Buffer.from('summary-png'), expect.stringMatching(/\.png$/));
    const image = imageOf(card.blocks);
    expect(image?.slack_file.id).toBe('F_SUMMARY');
    expect(image?.alt_text).toContain('Claude 지금');
    // Readonly overview: the picture replaces the per-account text and its paging.
    expect(str(card.blocks)).not.toContain('7d 잔여 50%'); // per-account rows
    expect(str(card.blocks)).not.toContain('공통 한도 여유'); // per-provider text summary
    expect(str(card.blocks)).not.toContain(`${AUTH_ACTION_IDS.page}_next`);
    expect(str(card.blocks)).toContain(AUTH_ACTION_IDS.report);
    // The fallback is the text card.
    expect(card.fallbackBlocks && imageOf(card.fallbackBlocks)).toBeUndefined();
    expect(str(card.fallbackBlocks)).toContain('공통 한도 여유');
  });

  it('renders the text card alone when the picture fails', async () => {
    vi.mocked(renderAuthSummaryPng).mockRejectedValueOnce(new Error('font missing'));
    const upload = vi.fn(async () => 'F_SUMMARY');
    const card = (await renderAuthCard({ userId: 'U_PLAIN', issuedAt: Date.now(), uploadImage: upload })) as Card;
    expect(upload).not.toHaveBeenCalled();
    expect(imageOf(card.blocks)).toBeUndefined();
    expect(card.fallbackBlocks).toBeUndefined();
    expect(str(card.blocks)).toContain('공통 한도 여유');
  });

  it('keeps account controls on the admin card, without the text summary lines', async () => {
    const card = (await renderAuthCard({
      userId: 'U_ADMIN',
      issuedAt: Date.now(),
      viewerMode: 'admin',
      uploadImage: async () => 'F_SUMMARY',
    })) as Card;
    expect(imageOf(card.blocks)).toBeDefined();
    expect(str(card.blocks)).toContain(AUTH_ACTION_IDS.switch);
    expect(str(card.blocks)).not.toContain('공통 한도 여유');
  });
});

describe('entry points', () => {
  it('naked `auth` uploads through the bot client and posts the picture card', async () => {
    const client = slackClient();
    const say = vi.fn(async () => ({}));
    await new AuthHandler({ slackApi: { getClient: () => client } } as never).execute({
      user: 'U_PLAIN',
      text: 'auth',
      threadTs: '111.222',
      say,
    } as unknown as CommandContext);
    expect(client.filesUploadV2).toHaveBeenCalledTimes(1);
    const [msg] = say.mock.calls[0] as unknown as [Card & { thread_ts: string }];
    expect(imageOf(msg.blocks)?.slack_file.id).toBe('F1');
    expect(msg.thread_ts).toBe('111.222');
  });

  it('naked `auth` falls back to the text card when Slack keeps refusing the fresh image', async () => {
    const client = slackClient();
    const say = vi.fn(async (msg: Card) => {
      if (imageOf(msg.blocks)) throw invalidBlocks();
      return {};
    });
    await new AuthHandler({ slackApi: { getClient: () => client } } as never).execute({
      user: 'U_PLAIN',
      text: 'auth',
      threadTs: '111.222',
      say,
    } as unknown as CommandContext);
    const last = say.mock.calls[say.mock.calls.length - 1]?.[0] as unknown as Card;
    expect(imageOf(last.blocks)).toBeUndefined();
    expect(str(last.blocks)).toContain('공통 한도 여유');
  }, 10_000);

  it('`/z auth` renders the picture when the topic gets the bot client', async () => {
    const client = slackClient();
    const card = (await createAuthTopicBinding().renderCard({
      userId: 'U_PLAIN',
      issuedAt: Date.now(),
      client,
    } as never)) as Card;
    expect(imageOf(card.blocks)?.slack_file.id).toBe('F1');
  });

  it('card buttons re-render with a fresh picture', async () => {
    type Handler = (ctx: Record<string, unknown>) => Promise<void>;
    const handlers: Array<{ pattern: string | RegExp; fn: Handler }> = [];
    registerAuthActions({
      action: (p: string | RegExp, fn: Handler) => handlers.push({ pattern: p, fn }),
      view: () => {},
    } as never);
    const refresh = handlers.find((h) => h.pattern === AUTH_ACTION_IDS.refresh);
    const client = slackClient();
    await refresh?.fn({
      ack: async () => {},
      body: {
        user: { id: 'U_PLAIN' },
        container: { type: 'message', channel_id: 'C1', message_ts: '111.222' },
        actions: [{ value: JSON.stringify({ viewerMode: 'readonly', page: 0 }) }],
      },
      client,
    });
    expect(client.filesUploadV2).toHaveBeenCalledTimes(1);
    const [update] = client.chat.update.mock.calls[0] as unknown as [Card];
    expect(imageOf(update.blocks)?.slack_file.id).toBe('F1');
  });
});

describe('[📋 계정별 리포트]', () => {
  type Handler = (ctx: Record<string, unknown>) => Promise<void>;
  function reportHandler(): Handler {
    const handlers: Array<{ pattern: string | RegExp; fn: Handler }> = [];
    registerAuthActions({
      action: (p: string | RegExp, fn: Handler) => handlers.push({ pattern: p, fn }),
      view: () => {},
    } as never);
    const found = handlers.find((h) => h.pattern === AUTH_ACTION_IDS.report);
    expect(found, 'report action registered').toBeDefined();
    return (found as { fn: Handler }).fn;
  }
  const body = (thread?: string) => ({
    user: { id: 'U_PLAIN' },
    container: { type: 'message', channel_id: 'C1', message_ts: '111.222', ...(thread ? { thread_ts: thread } : {}) },
    message: { ts: '111.222', ...(thread ? { thread_ts: thread } : {}) },
    actions: [{ value: 'report' }],
  });

  it('acks first, then posts the account picture into the card thread', async () => {
    const client = slackClient();
    const ack = vi.fn(async () => {});
    await reportHandler()({ ack, body: body('100.000'), client });
    expect(ack).toHaveBeenCalled();
    expect(renderAuthReportPng).toHaveBeenCalledTimes(1);
    const [msg] = client.chat.postMessage.mock.calls[0] as unknown as [Card & { channel: string; thread_ts: string }];
    expect(msg.channel).toBe('C1');
    expect(msg.thread_ts).toBe('100.000');
    expect(imageOf(msg.blocks)?.slack_file.id).toBe('F1');
    expect(str(msg.blocks)).toContain('<@U_PLAIN>');
  });

  it('threads under the card itself when the card is top-level', async () => {
    const client = slackClient();
    await reportHandler()({ ack: async () => {}, body: body(), client });
    const [msg] = client.chat.postMessage.mock.calls[0] as unknown as [{ thread_ts: string }];
    expect(msg.thread_ts).toBe('111.222');
  });

  it('posts the per-account text when the picture cannot be made', async () => {
    vi.mocked(renderAuthReportPng).mockRejectedValueOnce(new Error('resvg down'));
    const client = slackClient();
    await reportHandler()({ ack: async () => {}, body: body(), client });
    expect(client.filesUploadV2).not.toHaveBeenCalled();
    const [msg] = client.chat.postMessage.mock.calls[0] as unknown as [Card];
    expect(imageOf(msg.blocks)).toBeUndefined();
    expect(str(msg.blocks)).toContain('claude:ai10@x');
    expect(msg.blocks.length).toBeLessThanOrEqual(50);
  });
});
