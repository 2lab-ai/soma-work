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
    current: 'ai1',
    accounts: Array.from({ length: 10 }, (_, i) => ({
      name: `ai${i + 1}`,
      type: 'oauth',
      group: 'claude',
      status: 'ok',
      order: i + 1,
      five_hour: { utilization: 0.25, resets_at: 1_900_003_600, resets_in_secs: 3600 },
      seven_day: { utilization: 0.5, resets_at: 1_900_086_400, resets_in_secs: 86400 },
    })),
  })),
  switchLlmuxAccount: vi.fn(),
  addLlmuxAccount: vi.fn(),
  removeLlmuxAccount: vi.fn(),
  isLlmuxUp: vi.fn(),
  LlmuxClientError: class extends Error {},
}));

import { switchLlmuxAccount } from '../../../auth/llmux-client';
import { AuthHandler } from '../../commands/auth-handler';
import { createAuthTopicBinding } from '../../z/topics/auth-topic';
import { registerAuthActions } from '../actions';
import { AUTH_ACTION_IDS } from '../views';

type Card = { text?: string; blocks: Array<Record<string, unknown>> };
type Button = { action_id: string; value: string };
function button(card: Card, id: string): Button {
  const found = card.blocks.flatMap((b) => (b.elements ?? []) as Button[]).find((el) => el.action_id === id);
  expect(found, `missing button ${id}`).toBeDefined();
  return found as Button;
}
function contains(card: Card, value: string) {
  return JSON.stringify(card.blocks).includes(value);
}

async function open(userId: string): Promise<Card> {
  let card: Card | undefined;
  const handler = new AuthHandler();
  expect(handler.canHandle('auth')).toBe(true);
  await handler.execute({
    user: userId,
    text: 'auth',
    threadTs: '111.222',
    say: async (msg: Card) => {
      card = msg;
    },
  } as unknown as CommandContext);
  expect(card).toBeDefined();
  return card as Card;
}
function navigation() {
  type Handler = (ctx: Record<string, unknown>) => Promise<void>;
  const handlers: Array<{ pattern: string | RegExp; fn: Handler }> = [];
  registerAuthActions({
    action: (pattern: string | RegExp, fn: Handler) => handlers.push({ pattern, fn }),
    view: () => {},
  } as never);
  return async (userId: string, action: Button): Promise<Card> => {
    let card: Card | undefined;
    const entry = handlers.find(({ pattern }) =>
      typeof pattern === 'string' ? pattern === action.action_id : pattern.test(action.action_id),
    );
    expect(entry).toBeDefined();
    let acked = false;
    await entry?.fn({
      ack: async () => {
        acked = true;
      },
      body: {
        user: { id: userId },
        container: { type: 'message', channel_id: 'C1', message_ts: '111.222' },
        actions: [action],
      },
      client: {
        chat: {
          update: async (msg: Card) => {
            expect(acked).toBe(true);
            card = msg;
          },
        },
      },
    });
    expect(card).toBeDefined();
    return card as Card;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('T1–T3 real command → renderer → emitted button → registered action', () => {
  it('naked auth and the /z auth topic both open the same readonly overview for admins', async () => {
    const naked = await open('U_ADMIN');
    const topic = (await createAuthTopicBinding().renderCard({
      userId: 'U_ADMIN',
      issuedAt: Date.now(),
    } as never)) as Card;
    for (const card of [naked, topic]) {
      expect(contains(card, '*Claude*')).toBe(true);
      expect(contains(card, '7.50계정분')).toBe(true);
      expect(contains(card, AUTH_ACTION_IDS.settings)).toBe(false);
      expect(contains(card, AUTH_ACTION_IDS.switch)).toBe(false);
      expect(button(card, AUTH_ACTION_IDS.viewer).value).toContain('admin');
    }
  });

  it('opens controls only on opt-in, preserves admin through paging/refresh, and returns to overview', async () => {
    const click = navigation();
    let card = await open('U_ADMIN');
    card = await click('U_ADMIN', button(card, AUTH_ACTION_IDS.viewer));
    expect(contains(card, AUTH_ACTION_IDS.settings)).toBe(true);
    card = await click('U_ADMIN', button(card, `${AUTH_ACTION_IDS.page}_next`));
    expect(contains(card, '*ai10*')).toBe(true);
    expect(contains(card, AUTH_ACTION_IDS.settings)).toBe(true);
    card = await click('U_ADMIN', button(card, AUTH_ACTION_IDS.refresh));
    expect(contains(card, '*ai10*')).toBe(true);
    expect(contains(card, AUTH_ACTION_IDS.settings)).toBe(true);
    card = await click('U_ADMIN', button(card, AUTH_ACTION_IDS.viewer));
    expect(contains(card, AUTH_ACTION_IDS.settings)).toBe(false);
    expect(contains(card, '*ai10*')).toBe(true);
    expect(switchLlmuxAccount).not.toHaveBeenCalled();
  });

  it('a non-admin replaying an emitted admin toggle gets no controls or settings', async () => {
    const admin = await open('U_ADMIN');
    const plain = await navigation()('U_PLAIN', button(admin, AUTH_ACTION_IDS.viewer));
    for (const value of [
      AUTH_ACTION_IDS.viewer,
      AUTH_ACTION_IDS.settings,
      AUTH_ACTION_IDS.switch,
      'test-secret',
      'localhost',
    ]) {
      expect(contains(plain, value)).toBe(false);
    }
    expect(switchLlmuxAccount).not.toHaveBeenCalled();
  });
});
