import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mode: 'ccp',
  utilization: 10,
  acked: false,
  fetchUsage: vi.fn(),
  fetchStatus: vi.fn(async () => ({ current: null, accounts: [] })),
}));
vi.mock('../../../admin-utils', () => ({ isAdminUser: (id: string) => id === 'U_ADMIN' }));
vi.mock('../../../auth/auth-runtime', () => ({
  getAuthRuntimeSnapshot: () => ({ mode: mocks.mode, llmux: { baseUrl: 'http://localhost:3456', apiKey: 'test' } }),
  setAuthMode: vi.fn(),
  setLlmuxSettings: vi.fn(),
}));
vi.mock('../../../auth/llmux-client', () => ({
  fetchLlmuxStatus: mocks.fetchStatus,
  isLlmuxUp: vi.fn(),
  switchLlmuxAccount: vi.fn(),
  addLlmuxAccount: vi.fn(),
  removeLlmuxAccount: vi.fn(),
}));
vi.mock('../../../token-manager', () => ({
  getTokenManager: () => ({
    fetchUsageForAllAttached: mocks.fetchUsage,
    getSnapshot: async () => ({
      registry: {
        slots: Array.from({ length: 10 }, (_, i) => ({
          keyId: `slot-${i}`,
          name: `ai${i}`,
          kind: 'cct',
          source: 'setup',
          setupToken: 'fixture',
          createdAt: '2026-09-16T00:00:00Z',
          oauthAttachment: {
            accessToken: 'fixture',
            refreshToken: 'fixture',
            expiresAtMs: 1_900_000_000_000,
            scopes: ['user:profile'],
            acknowledgedConsumerTosRisk: true,
          },
        })),
      },
      state: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `slot-${i}`,
          {
            authState: 'healthy',
            activeLeases: [],
            usage: {
              fetchedAt: new Date().toISOString(),
              fiveHour: { utilization: mocks.utilization, resetsAt: '2030-01-01T00:00:00Z' },
            },
          },
        ]),
      ),
    }),
  }),
}));

import { registerAuthActions } from '../actions';
import { AUTH_ACTION_IDS } from '../views';

type Card = { blocks: Array<Record<string, unknown>> };
async function click(userId: string, viewerMode = 'readonly', id: string = AUTH_ACTION_IDS.refresh): Promise<Card> {
  type Handler = (args: Record<string, unknown>) => Promise<void>;
  const entries: Array<{ pattern: string | RegExp; fn: Handler }> = [];
  registerAuthActions({
    action: (pattern: string | RegExp, fn: Handler) => entries.push({ pattern, fn }),
    view: () => {},
  } as never);
  const entry = entries.find(({ pattern }) => (typeof pattern === 'string' ? pattern === id : pattern.test(id)));
  let card: Card | undefined;
  await entry?.fn({
    ack: async () => {
      mocks.acked = true;
    },
    body: {
      user: { id: userId },
      container: { type: 'message', channel_id: 'C1', message_ts: '1.2' },
      actions: [{ value: JSON.stringify({ viewerMode, page: 1 }) }],
    },
    client: {
      chat: {
        update: async (value: Card) => {
          card = value;
        },
      },
    },
  });
  expect(card).toBeDefined();
  return card as Card;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = 'ccp';
  mocks.acked = false;
  mocks.utilization = 10;
  mocks.fetchUsage.mockImplementation(async () => {
    expect(mocks.acked).toBe(true);
    mocks.utilization = 42;
    return { 'slot-8': { fiveHour: { utilization: 42 } } };
  });
});

describe('T2/T3 legacy auth refresh uses real non-force fetch before rendering', () => {
  it.each([
    ['U_PLAIN', 'readonly'],
    ['U_ADMIN', 'readonly'],
    ['U_ADMIN', 'admin'],
  ])('refresh %s %s fetches once and retains page/view', async (user, mode) => {
    const card = await click(user, mode);
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(1);
    expect(mocks.fetchUsage).toHaveBeenCalledWith({ timeoutMs: expect.any(Number) });
    const text = JSON.stringify(card);
    expect(text).toContain('42%');
    expect(text).toContain('ai8');
    const refresh = card.blocks
      .flatMap((b) => (b.elements ?? []) as Array<{ action_id?: string; value?: string }>)
      .find((b) => b.action_id === AUTH_ACTION_IDS.refresh);
    expect(refresh?.value).toBeDefined();
    expect(JSON.parse(refresh?.value ?? '{}')).toEqual({ viewerMode: mode, page: 1 });
    expect(text).toContain('Auth');
    expect(card.blocks.length).toBeLessThanOrEqual(49);
  });
  it.each(['throttled', 'failed'])('renders cached data with visible notice when %s', async (outcome) => {
    if (outcome === 'throttled') mocks.fetchUsage.mockResolvedValue({ 'slot-8': null });
    else mocks.fetchUsage.mockRejectedValue(new Error('fixture failure'));
    const card = await click('U_PLAIN');
    expect(mocks.fetchUsage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(card)).toContain('Cached usage');
    expect(JSON.stringify(card)).toContain('10%');
    expect(JSON.stringify(card)).toContain(AUTH_ACTION_IDS.refresh);
  });
  it('does not poll for readonly pagination or report an empty fleet as failed', async () => {
    await click('U_PLAIN', 'readonly', `${AUTH_ACTION_IDS.page}_prev`);
    expect(mocks.fetchUsage).not.toHaveBeenCalled();
    mocks.fetchUsage.mockResolvedValue({});
    expect(JSON.stringify(await click('U_PLAIN'))).not.toContain('Cached usage');
  });
  it('llmux refresh only fetches llmux status', async () => {
    mocks.mode = 'llmux';
    await click('U_PLAIN');
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    expect(mocks.fetchUsage).not.toHaveBeenCalled();
  });
});
