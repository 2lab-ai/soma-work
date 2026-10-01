/**
 * T3 follow-up (#auth-capacity-overview) — auth-origin routing through the
 * CCT mutation handlers.
 *
 * A CCT card embedded in the `auth` ccp wrapper stamps every tagged button
 * value as `cm:<mode>|ao:<page>|<inner>` and every modal's
 * `private_metadata` as auth-origin JSON. The handlers must:
 *   - decode the wrapper transparently (inner payload drives the mutation),
 *   - re-render the AUTH WRAPPER (renderAuthCard, with the encoded page)
 *     instead of the bare CCT card after the mutation,
 *   - keep DIRECT card flows byte-identical (no origin → existing path).
 *
 * Topic renderers are mocked (same pattern as `actions.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../z/topics/cct-topic', () => ({
  renderCctCard: vi.fn(async () => ({
    text: ':key: CCT (active: none)',
    blocks: [{ type: 'section', block_id: 'bare_cct_stub', text: { type: 'mrkdwn', text: 'bare cct card' } }],
  })),
}));

vi.mock('../../z/topics/auth-topic', () => ({
  renderAuthCard: vi.fn(async () => ({
    text: '🔐 Auth: cct (legacy)',
    blocks: [{ type: 'section', block_id: 'auth_wrapper_stub', text: { type: 'mrkdwn', text: 'auth wrapper card' } }],
  })),
}));

import { resetAdminUsersCache } from '../../../admin-utils';
import { renderAuthCard } from '../../z/topics/auth-topic';
import { renderCctCard } from '../../z/topics/cct-topic';
import { registerCctActions } from '../actions';
import { CCT_ACTION_IDS, CCT_BLOCK_IDS, CCT_VIEW_IDS } from '../views';

type Handler = (ctx: Record<string, unknown>) => Promise<void>;

function makeApp() {
  const actionHandlers = new Map<string, Handler>();
  const viewHandlers = new Map<string, Handler>();
  const app = {
    action: (id: string, fn: Handler) => actionHandlers.set(id, fn),
    view: (id: string, fn: Handler) => viewHandlers.set(id, fn),
  } as never;
  return { app, actionHandlers, viewHandlers };
}

function makeClient() {
  return {
    chat: {
      update: vi.fn(async (_a?: unknown) => undefined),
      postEphemeral: vi.fn(async (_a?: unknown) => undefined),
      postMessage: vi.fn(async (_a?: unknown) => undefined),
    },
    views: {
      open: vi.fn(async (_a?: unknown) => undefined),
      update: vi.fn(async (_a?: unknown) => undefined),
    },
    conversations: { open: vi.fn(async () => ({ channel: { id: 'D1' } })) },
  };
}

function msgBody(value: string): Record<string, unknown> {
  return {
    user: { id: 'U_ADMIN' },
    trigger_id: 'T1',
    container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
    actions: [{ value }],
  };
}

const SLOT_B = {
  kind: 'cct' as const,
  source: 'setup' as const,
  keyId: 'slot-B',
  name: 'cctB',
  setupToken: 'sk-ant-oat01-x',
  oauthAttachment: {
    accessToken: 't',
    refreshToken: 'r',
    expiresAtMs: Date.now() + 3_600_000,
    scopes: ['user:profile', 'user:inference'],
    acknowledgedConsumerTosRisk: true as const,
  },
  createdAt: '2026-09-01T00:00:00Z',
};

function fakeTm(overrides: Record<string, unknown> = {}) {
  return {
    getSnapshot: vi.fn(async () => ({
      version: 2 as const,
      revision: 1,
      registry: { activeKeyId: 'slot-A', slots: [SLOT_B] },
      state: {},
    })),
    listTokens: () => [],
    getActiveToken: () => null,
    applyToken: vi.fn(async () => undefined),
    detachOAuth: vi.fn(async () => undefined),
    rotateToNext: vi.fn(async () => ({ keyId: 'slot-B', name: 'cctB' })),
    removeSlot: vi.fn(async () => ({ pendingDrain: false })),
    attachOAuth: vi.fn(async () => undefined),
    addSlot: vi.fn(async () => undefined),
    refreshAllAttachedOAuthTokens: vi.fn(async () => ({}) as Record<string, 'ok' | 'error'>),
    fetchUsageForAllAttached: vi.fn(async () => ({})),
    fetchAndStoreUsage: vi.fn(async () => null),
    ...overrides,
  } as never;
}

const GOOD_OAUTH_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-xxxxxxxx',
    refreshToken: 'refreshvalue',
    expiresAt: Date.parse('2027-12-31T00:00:00Z'),
    scopes: ['user:profile', 'user:inference'],
  },
});

const ORIGIN_META = (payload: string) =>
  JSON.stringify({ cctAuthOrigin: { page: 2, channel: 'C1', ts: 'ts1' }, payload });

const PREV_ADMIN_USERS = process.env.ADMIN_USERS;

beforeEach(() => {
  process.env.ADMIN_USERS = 'U_ADMIN';
  resetAdminUsersCache();
  vi.mocked(renderAuthCard).mockClear();
  vi.mocked(renderCctCard).mockClear();
});

afterEach(() => {
  if (PREV_ADMIN_USERS === undefined) delete process.env.ADMIN_USERS;
  else process.env.ADMIN_USERS = PREV_ADMIN_USERS;
  resetAdminUsersCache();
});

describe('button mutations — auth-origin value re-renders the AUTH wrapper', () => {
  it('activate with cm:admin|ao:2|slot-B → applyToken(slot-B) + auth wrapper chat.update at page 2', async () => {
    const { app, actionHandlers } = makeApp();
    const tm = fakeTm();
    registerCctActions(app as never, tm);
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.activate_slot)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|ao:2|slot-B'),
      client,
      respond: vi.fn(),
    });
    expect((tm as { applyToken: ReturnType<typeof vi.fn> }).applyToken).toHaveBeenCalledWith('slot-B');
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin', page: 2 }),
    );
    expect(renderCctCard).not.toHaveBeenCalled();
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const arg = client.chat.update.mock.calls[0]?.[0] as { blocks: Array<{ block_id?: string }> };
    expect(arg.blocks.some((b) => b.block_id === 'auth_wrapper_stub')).toBe(true);
  });

  it('activate with plain cm:admin|slot-B (direct card) → bare CCT path unchanged', async () => {
    const { app, actionHandlers } = makeApp();
    const tm = fakeTm();
    registerCctActions(app as never, tm);
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.activate_slot)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|slot-B'),
      client,
      respond: vi.fn(),
    });
    expect((tm as { applyToken: ReturnType<typeof vi.fn> }).applyToken).toHaveBeenCalledWith('slot-B');
    expect(renderCctCard).toHaveBeenCalledTimes(1);
    expect(renderAuthCard).not.toHaveBeenCalled();
  });

  it('detach with auth-origin value → detachOAuth(inner keyId) + auth wrapper re-render', async () => {
    const { app, actionHandlers } = makeApp();
    const tm = fakeTm();
    registerCctActions(app as never, tm);
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.detach)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|ao:0|slot-B'),
      client,
      respond: vi.fn(),
    });
    expect((tm as { detachOAuth: ReturnType<typeof vi.fn> }).detachOAuth).toHaveBeenCalledWith('slot-B');
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ viewerMode: 'admin', page: 0 }));
    expect(renderCctCard).not.toHaveBeenCalled();
  });

  it('next with auth-origin value → rotateToNext + auth wrapper re-render', async () => {
    const { app, actionHandlers } = makeApp();
    const tm = fakeTm();
    registerCctActions(app as never, tm);
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.next)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|ao:1|next'),
      client,
      respond: vi.fn(),
    });
    expect((tm as { rotateToNext: ReturnType<typeof vi.fn> }).rotateToNext).toHaveBeenCalledTimes(1);
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });

  it('refresh_usage_all all-failed with auth-origin → auth wrapper re-render with allNull banner first', async () => {
    const { app, actionHandlers } = makeApp();
    const tm = fakeTm({
      getSnapshot: vi.fn(async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-B', slots: [SLOT_B] },
        state: { 'slot-B': { authState: 'healthy', activeLeases: [] } },
      })),
      refreshAllAttachedOAuthTokens: vi.fn(async () => ({ 'slot-B': 'error' }) as Record<string, 'ok' | 'error'>),
    });
    registerCctActions(app as never, tm);
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.refresh_usage_all)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|ao:2|refresh_all'),
      client,
      respond: vi.fn(),
    });
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ viewerMode: 'admin', page: 2 }));
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const arg = client.chat.update.mock.calls[0]?.[0] as { blocks: Array<{ text?: { text?: string } }> };
    expect(arg.blocks[0]?.text?.text).toContain('nothing refreshed');
  });
});

describe('modal opens — auth-origin value stamps metadata (direct unchanged)', () => {
  it('remove open with auth-origin value → private_metadata carries origin JSON + surface + keyId', async () => {
    const { app, actionHandlers } = makeApp();
    registerCctActions(app as never, fakeTm());
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.remove)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|ao:2|slot-B'),
      client,
    });
    expect(client.views.open).toHaveBeenCalledTimes(1);
    const view = (client.views.open.mock.calls[0]?.[0] as { view: { private_metadata?: string } }).view;
    expect(JSON.parse(view.private_metadata ?? '')).toEqual({
      cctAuthOrigin: { page: 2, channel: 'C1', ts: 'ts1' },
      payload: 'slot-B',
    });
  });

  it('remove open with direct value → private_metadata stays the bare keyId', async () => {
    const { app, actionHandlers } = makeApp();
    registerCctActions(app as never, fakeTm());
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.remove)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|slot-B'),
      client,
    });
    const view = (client.views.open.mock.calls[0]?.[0] as { view: { private_metadata?: string } }).view;
    expect(view.private_metadata).toBe('slot-B');
  });

  it('attach open with auth-origin value → origin metadata stamped', async () => {
    const { app, actionHandlers } = makeApp();
    registerCctActions(app as never, fakeTm());
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.attach)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|ao:2|slot-B'),
      client,
    });
    const view = (client.views.open.mock.calls[0]?.[0] as { view: { private_metadata?: string } }).view;
    expect(JSON.parse(view.private_metadata ?? '').cctAuthOrigin).toEqual({ page: 2, channel: 'C1', ts: 'ts1' });
  });

  it('add open with auth-origin value → origin metadata stamped with payload "add"', async () => {
    const { app, actionHandlers } = makeApp();
    registerCctActions(app as never, fakeTm());
    const client = makeClient();
    await actionHandlers.get(CCT_ACTION_IDS.add)?.({
      ack: vi.fn(async () => undefined),
      body: msgBody('cm:admin|ao:1|add'),
      client,
    });
    const view = (client.views.open.mock.calls[0]?.[0] as { view: { private_metadata?: string } }).view;
    expect(JSON.parse(view.private_metadata ?? '')).toEqual({
      cctAuthOrigin: { page: 1, channel: 'C1', ts: 'ts1' },
      payload: 'add',
    });
  });

  it('kind_radio flip preserves private_metadata across views.update', async () => {
    const { app, actionHandlers } = makeApp();
    registerCctActions(app as never, fakeTm());
    const client = makeClient();
    const pm = ORIGIN_META('add');
    await actionHandlers.get(CCT_ACTION_IDS.kind_radio)?.({
      ack: vi.fn(async () => undefined),
      body: {
        user: { id: 'U_ADMIN' },
        view: { id: 'V1', hash: 'h1', private_metadata: pm },
        actions: [{ selected_option: { value: 'api_key' } }],
      },
      client,
    });
    expect(client.views.update).toHaveBeenCalledTimes(1);
    const updated = (client.views.update.mock.calls[0]?.[0] as { view: { private_metadata?: string } }).view;
    expect(updated.private_metadata).toBe(pm);
  });
});

describe('modal submits — auth-origin metadata re-renders the auth wrapper at the stored surface', () => {
  it('remove submit with origin metadata → removeSlot(inner keyId) + auth wrapper chat.update, no bare ephemeral card', async () => {
    const { app, viewHandlers } = makeApp();
    const tm = fakeTm();
    registerCctActions(app as never, tm);
    const client = makeClient();
    await viewHandlers.get(CCT_VIEW_IDS.remove)?.({
      ack: vi.fn(async () => undefined),
      body: { user: { id: 'U_ADMIN' }, view: { private_metadata: ORIGIN_META('slot-B') } },
      client,
    });
    expect((tm as { removeSlot: ReturnType<typeof vi.fn> }).removeSlot).toHaveBeenCalledWith('slot-B');
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ viewerMode: 'admin', page: 2 }));
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', ts: 'ts1' }));
    expect(client.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it('remove submit with bare keyId metadata (direct) → existing ephemeral-card path, no auth render', async () => {
    const { app, viewHandlers } = makeApp();
    const tm = fakeTm();
    registerCctActions(app as never, tm);
    const client = makeClient();
    await viewHandlers.get(CCT_VIEW_IDS.remove)?.({
      ack: vi.fn(async () => undefined),
      body: {
        user: { id: 'U_ADMIN' },
        container: { channel_id: 'C1' },
        view: { private_metadata: 'slot-B' },
      },
      client,
    });
    expect((tm as { removeSlot: ReturnType<typeof vi.fn> }).removeSlot).toHaveBeenCalledWith('slot-B');
    expect(renderAuthCard).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('attach submit with origin metadata → attachOAuth(inner keyId) + auth wrapper update at surface', async () => {
    const { app, viewHandlers } = makeApp();
    const tm = fakeTm();
    registerCctActions(app as never, tm);
    const client = makeClient();
    const ack = vi.fn(async () => undefined);
    await viewHandlers.get(CCT_VIEW_IDS.attach)?.({
      ack,
      body: {
        user: { id: 'U_ADMIN' },
        view: {
          private_metadata: ORIGIN_META('slot-B'),
          state: {
            values: {
              [CCT_BLOCK_IDS.attach_oauth_blob]: {
                [CCT_ACTION_IDS.attach_oauth_input]: { value: GOOD_OAUTH_BLOB },
              },
              [CCT_BLOCK_IDS.attach_tos_ack]: {
                [CCT_ACTION_IDS.attach_tos_ack]: { selected_options: [{ value: 'ack' }] },
              },
            },
          },
        },
      },
      client,
    });
    expect(ack).toHaveBeenCalledWith();
    expect((tm as { attachOAuth: ReturnType<typeof vi.fn> }).attachOAuth).toHaveBeenCalledWith(
      'slot-B',
      expect.objectContaining({ accessToken: expect.any(String) }),
      true,
    );
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ viewerMode: 'admin', page: 2 }));
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', ts: 'ts1' }));
    expect(client.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it('add submit with origin metadata → addSlot + auth wrapper update at surface, no bare ephemeral card', async () => {
    const { app, viewHandlers } = makeApp();
    const tm = fakeTm();
    registerCctActions(app as never, tm);
    const client = makeClient();
    await viewHandlers.get(CCT_VIEW_IDS.add)?.({
      ack: vi.fn(async () => undefined),
      body: {
        user: { id: 'U_ADMIN' },
        view: {
          private_metadata: ORIGIN_META('add'),
          state: {
            values: {
              [CCT_BLOCK_IDS.add_name]: { [CCT_ACTION_IDS.name_input]: { value: 'new-slot' } },
              [CCT_BLOCK_IDS.add_kind]: {
                [CCT_ACTION_IDS.kind_radio]: { selected_option: { value: 'setup_token' } },
              },
              [CCT_BLOCK_IDS.add_setup_token_value]: {
                [CCT_ACTION_IDS.setup_token_input]: { value: 'sk-ant-oat01-abcdefgh' },
              },
            },
          },
        },
      },
      client,
    });
    expect((tm as { addSlot: ReturnType<typeof vi.fn> }).addSlot).toHaveBeenCalledTimes(1);
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ viewerMode: 'admin', page: 2 }));
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', ts: 'ts1' }));
    expect(client.chat.postEphemeral).not.toHaveBeenCalled();
  });
});
