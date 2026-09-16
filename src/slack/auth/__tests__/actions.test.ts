/**
 * T3 (#auth-capacity-overview) — auth card action routing.
 *
 * Contract under test (fake Bolt App register → click):
 *   - `auth_view_mode` / `auth_page` / `auth_refresh` retain the
 *     card-encoded `{viewerMode,page}` JSON value but RE-CHECK the actor's
 *     authorization: a forged/stale `viewerMode:'admin'` from a non-admin
 *     actor demotes to `readonly` (encoded card state is untrusted input).
 *   - every handler acks BEFORE any render/mutation work (3s budget).
 *   - existing mutating actions + modal submits remain admin-gated and
 *     re-render the ADMIN card after success AND failure (the actor was
 *     admin-gated, so the post-mutation surface stays in admin mode).
 *
 * The topic renderer is mocked (same pattern as `cct/__tests__/actions.test.ts`
 * mocking `renderCctCard`) — these tests pin the routing/authorization
 * contract, not the card markup (builder tests own that).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../z/topics/auth-topic', () => ({
  renderAuthCard: vi.fn(async () => ({
    text: '🔐 Auth',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'auth card body' } }],
  })),
  applyAuthMode: vi.fn(async () => ({ ok: true, summary: '🔐 Auth mode → *llmux*' })),
}));

vi.mock('../../../auth/auth-runtime', () => ({
  getAuthRuntimeSnapshot: vi.fn(() => ({
    mode: 'llmux',
    llmux: { baseUrl: 'http://localhost:3456', apiKey: 'proxy-key-xyz1' },
  })),
  setLlmuxSettings: vi.fn(),
}));

vi.mock('../../../auth/llmux-client', () => {
  class LlmuxClientError extends Error {}
  return {
    LlmuxClientError,
    addLlmuxAccount: vi.fn(async () => ({ name: 'api-1', added: true, type: 'api_key' })),
    removeLlmuxAccount: vi.fn(async () => undefined),
    switchLlmuxAccount: vi.fn(async () => ({ current: 'acc-1' })),
    isLlmuxUp: vi.fn(async () => true),
  };
});

import { resetAdminUsersCache } from '../../../admin-utils';
import { addLlmuxAccount, switchLlmuxAccount } from '../../../auth/llmux-client';
import { applyAuthMode, renderAuthCard } from '../../z/topics/auth-topic';
import { registerAuthActions } from '../actions';
import { AUTH_ACTION_IDS, AUTH_BLOCK_IDS, AUTH_VIEW_IDS } from '../views';

type Handler = (ctx: Record<string, unknown>) => Promise<void>;

function makeApp() {
  const actionEntries: Array<{ pattern: string | RegExp; fn: Handler }> = [];
  const viewHandlers = new Map<string, Handler>();
  const app = {
    action: (pattern: string | RegExp, fn: Handler) => {
      actionEntries.push({ pattern, fn });
    },
    view: (id: string, fn: Handler) => {
      viewHandlers.set(id, fn);
    },
  } as never;
  /** Simulate a button click: route `actionId` through the registered handlers. */
  const click = async (actionId: string, ctx: Record<string, unknown>): Promise<void> => {
    const entry = actionEntries.find((e) =>
      typeof e.pattern === 'string' ? e.pattern === actionId : e.pattern.test(actionId),
    );
    expect(entry, `no handler registered for action ${actionId}`).toBeDefined();
    await entry?.fn(ctx);
  };
  return { app, click, viewHandlers, actionEntries };
}

/** Message-surface block_action body (renderInPlace → chat.update path). */
function msgBody(userId: string, value?: string): Record<string, unknown> {
  return {
    user: { id: userId },
    trigger_id: 'T1',
    container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
    actions: value === undefined ? [] : [{ value }],
  };
}

function makeClient() {
  return {
    chat: {
      update: vi.fn(async (_arg?: unknown) => undefined),
      postEphemeral: vi.fn(async (_arg?: unknown) => undefined),
    },
    views: { open: vi.fn(async (_arg?: unknown) => undefined) },
  };
}

function makeCtx(userId: string, value?: string) {
  const client = makeClient();
  return {
    ack: vi.fn(async () => undefined),
    body: msgBody(userId, value),
    client,
    respond: vi.fn(async () => undefined),
  };
}

const navValue = (viewerMode: 'admin' | 'readonly', page: number) => JSON.stringify({ viewerMode, page });

const PREV_ADMIN_USERS = process.env.ADMIN_USERS;

beforeEach(() => {
  process.env.ADMIN_USERS = 'U_ADMIN';
  resetAdminUsersCache();
  vi.mocked(renderAuthCard).mockClear();
  vi.mocked(applyAuthMode).mockClear();
  vi.mocked(switchLlmuxAccount).mockClear();
  vi.mocked(addLlmuxAccount).mockClear();
});

afterEach(() => {
  if (PREV_ADMIN_USERS === undefined) delete process.env.ADMIN_USERS;
  else process.env.ADMIN_USERS = PREV_ADMIN_USERS;
  resetAdminUsersCache();
});

describe('auth_view_mode (viewer toggle) — authorization recheck', () => {
  it('registers a handler for the new AUTH_ACTION_IDS.viewer id', async () => {
    const { app, actionEntries } = makeApp();
    registerAuthActions(app);
    const entry = actionEntries.find((e) =>
      typeof e.pattern === 'string' ? e.pattern === 'auth_view_mode' : e.pattern.test('auth_view_mode'),
    );
    expect(AUTH_ACTION_IDS.viewer).toBe('auth_view_mode');
    expect(entry).toBeDefined();
  });

  it('non-admin clicking a forged {viewerMode:"admin"} value → readonly re-render (page retained)', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_PLAIN', navValue('admin', 2));
    await click(AUTH_ACTION_IDS.viewer, ctx);
    expect(renderAuthCard).toHaveBeenCalledTimes(1);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_PLAIN', viewerMode: 'readonly', page: 2 }),
    );
    // Message surface re-renders in place.
    expect(ctx.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it('admin requesting admin mode → admin re-render', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_ADMIN', navValue('admin', 0));
    await click(AUTH_ACTION_IDS.viewer, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin', page: 0 }),
    );
  });

  it('admin returning to Overview ({viewerMode:"readonly"}) → readonly re-render', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_ADMIN', navValue('readonly', 1));
    await click(AUTH_ACTION_IDS.viewer, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'readonly', page: 1 }),
    );
  });

  it('acks BEFORE rendering work', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const callOrder: string[] = [];
    vi.mocked(renderAuthCard).mockImplementationOnce(async () => {
      callOrder.push('render');
      return { text: '🔐 Auth', blocks: [] };
    });
    const ctx = makeCtx('U_ADMIN', navValue('admin', 0));
    (ctx.ack as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      expect(renderAuthCard).not.toHaveBeenCalled();
      callOrder.push('ack');
    });
    await click(AUTH_ACTION_IDS.viewer, ctx);
    expect(callOrder).toEqual(['ack', 'render']);
  });
});

describe('auth_page (pagination) — authorization recheck', () => {
  it('registers a handler for the new AUTH_ACTION_IDS.page id', () => {
    const { app, actionEntries } = makeApp();
    registerAuthActions(app);
    const entry = actionEntries.find((e) =>
      typeof e.pattern === 'string' ? e.pattern === 'auth_page' : e.pattern.test('auth_page'),
    );
    expect(AUTH_ACTION_IDS.page).toBe('auth_page');
    expect(entry).toBeDefined();
  });

  it('admin paging an admin card → admin re-render at target page', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_ADMIN', navValue('admin', 3));
    await click(AUTH_ACTION_IDS.page, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin', page: 3 }),
    );
  });

  it('non-admin paging with a forged admin stamp → readonly re-render at target page', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_PLAIN', navValue('admin', 3));
    await click(AUTH_ACTION_IDS.page, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_PLAIN', viewerMode: 'readonly', page: 3 }),
    );
  });

  it('malformed page payload falls back to readonly page 0 (fail-safe)', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_ADMIN', '{"viewerMode":"admin","page":-7}');
    await click(AUTH_ACTION_IDS.page, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ viewerMode: 'admin', page: 0 }));
  });

  // Slack requires unique action_ids within one actions block, so the
  // builder suffixes the two paging buttons. Both route to the same
  // handler; the target page comes from the VALUE, not the id suffix.
  it.each([
    ['auth_page_prev'],
    ['auth_page_next'],
  ])('suffixed paging id %s routes to the page handler (target page from value)', async (suffixedId) => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_ADMIN', navValue('admin', 5));
    await click(suffixedId, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin', page: 5 }),
    );
  });

  it('suffixed paging id does NOT leak to unrelated auth_page-prefixed ids', () => {
    const { app, actionEntries } = makeApp();
    registerAuthActions(app);
    const match = (id: string) =>
      actionEntries.some((e) => (typeof e.pattern === 'string' ? e.pattern === id : e.pattern.test(id)));
    expect(match('auth_page')).toBe(true);
    expect(match('auth_page_prev')).toBe(true);
    expect(match('auth_page_next')).toBe(true);
    expect(match('auth_page_other')).toBe(false);
  });
});

describe('auth_refresh — retains encoded mode, rechecks actor', () => {
  it('admin refresh on an admin-stamped card → admin re-render, page retained', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_ADMIN', navValue('admin', 1));
    await click(AUTH_ACTION_IDS.refresh, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin', page: 1 }),
    );
  });

  it('non-admin refresh on an admin-stamped card → demoted to readonly', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_PLAIN', navValue('admin', 1));
    await click(AUTH_ACTION_IDS.refresh, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_PLAIN', viewerMode: 'readonly', page: 1 }),
    );
  });

  it('legacy plain "refresh" value (pre-T3 button) → readonly page 0', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_ADMIN', 'refresh');
    await click(AUTH_ACTION_IDS.refresh, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'readonly', page: 0 }),
    );
  });

  it('acks BEFORE the fresh render fetch', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const callOrder: string[] = [];
    vi.mocked(renderAuthCard).mockImplementationOnce(async () => {
      callOrder.push('render');
      return { text: '🔐 Auth', blocks: [] };
    });
    const ctx = makeCtx('U_PLAIN', navValue('readonly', 0));
    (ctx.ack as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('ack');
    });
    await click(AUTH_ACTION_IDS.refresh, ctx);
    expect(callOrder).toEqual(['ack', 'render']);
  });
});

describe('existing mutating actions stay admin-gated and re-render ADMIN mode', () => {
  it('mode switch by non-admin → applyAuthMode NOT called', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_PLAIN', 'llmux');
    await click(`${AUTH_ACTION_IDS.mode}_llmux`, ctx);
    expect(applyAuthMode).not.toHaveBeenCalled();
    expect(ctx.ack).toHaveBeenCalled();
  });

  it('mode switch by admin → applyAuthMode called, admin card re-rendered (success)', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_ADMIN', 'llmux');
    await click(`${AUTH_ACTION_IDS.mode}_llmux`, ctx);
    expect(applyAuthMode).toHaveBeenCalledWith({ userId: 'U_ADMIN', mode: 'llmux' });
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin' }));
    expect(ctx.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it('llmux account switch failure → banner + admin card re-rendered (failure path)', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    vi.mocked(switchLlmuxAccount).mockRejectedValueOnce(new Error('scheduler refused'));
    const ctx = makeCtx('U_ADMIN', 'acc-2');
    await click(AUTH_ACTION_IDS.switch, ctx);
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin' }));
    expect(ctx.client.chat.update).toHaveBeenCalledTimes(1);
    const updateArg = ctx.client.chat.update.mock.calls[0]?.[0] as { blocks: Array<{ text?: { text?: string } }> };
    expect(updateArg.blocks[0]?.text?.text).toContain('Switch failed');
  });

  it('llmux account switch by non-admin → no switch call', async () => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_PLAIN', 'acc-2');
    await click(AUTH_ACTION_IDS.switch, ctx);
    expect(switchLlmuxAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['settings', AUTH_ACTION_IDS.settings],
    ['add', AUTH_ACTION_IDS.add],
    ['remove', AUTH_ACTION_IDS.remove],
  ])('modal-open %s by non-admin → views.open NOT called', async (_label, actionId) => {
    const { app, click } = makeApp();
    registerAuthActions(app);
    const ctx = makeCtx('U_PLAIN', 'anything');
    await click(actionId, ctx);
    expect(ctx.client.views.open).not.toHaveBeenCalled();
  });
});

describe('modal submits stay admin-gated and re-render ADMIN mode at the card surface', () => {
  function addSubmitBody(userId: string): Record<string, unknown> {
    return {
      user: { id: userId },
      view: {
        private_metadata: JSON.stringify({ channel: 'C1', ts: 'ts1' }),
        state: {
          values: {
            [AUTH_BLOCK_IDS.add_api_key]: { value: { value: 'sk-ant-api03-zzz' } },
            [AUTH_BLOCK_IDS.add_name]: { value: { value: '' } },
          },
        },
      },
    };
  }

  it('add-account submit by non-admin → plain ack, no addLlmuxAccount call', async () => {
    const { app, viewHandlers } = makeApp();
    registerAuthActions(app);
    const submit = viewHandlers.get(AUTH_VIEW_IDS.add);
    expect(submit).toBeDefined();
    const ack = vi.fn(async () => undefined);
    const client = makeClient();
    await submit?.({ ack, body: addSubmitBody('U_PLAIN'), client });
    expect(addLlmuxAccount).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('add-account submit by admin (success) → admin card re-rendered at the stored surface', async () => {
    const { app, viewHandlers } = makeApp();
    registerAuthActions(app);
    const submit = viewHandlers.get(AUTH_VIEW_IDS.add);
    const ack = vi.fn(async () => undefined);
    const client = makeClient();
    await submit?.({ ack, body: addSubmitBody('U_ADMIN'), client });
    expect(addLlmuxAccount).toHaveBeenCalledTimes(1);
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin' }));
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', ts: 'ts1' }));
  });

  it('add-account submit by admin (failure) → admin card re-rendered with failure banner', async () => {
    const { app, viewHandlers } = makeApp();
    registerAuthActions(app);
    vi.mocked(addLlmuxAccount).mockRejectedValueOnce(new Error('llmux down'));
    const submit = viewHandlers.get(AUTH_VIEW_IDS.add);
    const client = makeClient();
    await submit?.({ ack: vi.fn(async () => undefined), body: addSubmitBody('U_ADMIN'), client });
    expect(renderAuthCard).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U_ADMIN', viewerMode: 'admin' }));
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const updateArg = client.chat.update.mock.calls[0]?.[0] as { blocks: Array<{ text?: { text?: string } }> };
    expect(updateArg.blocks[0]?.text?.text).toContain('Add failed');
  });
});
