/**
 * Unit coverage for the view-submission validator and the view-update
 * contract on the kind radio. The full Bolt registration (`registerCctActions`)
 * is covered by integration in the wiring test; here we focus on the
 * validation surface and the stability of block_ids across a kind flip.
 */

import { describe, expect, it, vi } from 'vitest';

// Codex P2 follow-up (#679): the `refresh_card` handler must call
// `renderCctCard` on persistent message surfaces so the trailing
// `z_setting_cct_cancel` button (added by the cct-topic renderer, not by
// `buildCardFromManager`) is preserved across chat.update. Mock the
// topic renderer so these tests don't pull the heavy admin-check +
// fetchUsageForAllAttached + buildCctCardBlocks pipeline; we only care
// about the renderer-selection contract.
vi.mock('../../z/topics/cct-topic', () => ({
  renderCctCard: vi.fn(async () => ({
    text: ':key: CCT (active: none)',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: ':key: CCT Tokens' } },
      {
        type: 'actions',
        elements: [{ type: 'button', action_id: 'z_setting_cct_cancel', value: 'cancel' }],
      },
    ],
  })),
}));

import { renderCctCard } from '../../z/topics/cct-topic';
import {
  buildCardFromManager,
  parseOAuthBlob,
  REFRESH_BANNERS,
  registerCctActions,
  validateAddSubmission,
} from '../actions';
import { buildAddSlotModal } from '../builder';
import { CCT_ACTION_IDS, CCT_BLOCK_IDS } from '../views';

type Values = Record<string, Record<string, any>>;

function withName(name: string, extra: Values = {}): Values {
  return {
    [CCT_BLOCK_IDS.add_name]: {
      cct_name_value: { type: 'plain_text_input', value: name },
    },
    ...extra,
  };
}

function withKind(kind: 'setup_token' | 'oauth_credentials' | 'api_key', extra: Values = {}): Values {
  return {
    [CCT_BLOCK_IDS.add_kind]: {
      cct_kind_radio: { type: 'radio_buttons', selected_option: { value: kind } },
    },
    ...extra,
  };
}

function setupTokenValue(val: string): Values {
  return {
    [CCT_BLOCK_IDS.add_setup_token_value]: {
      cct_setup_token_value: { type: 'plain_text_input', value: val },
    },
  };
}

function oauthBlobValue(val: string): Values {
  return {
    [CCT_BLOCK_IDS.add_oauth_credentials_blob]: {
      cct_oauth_blob_value: { type: 'plain_text_input', value: val },
    },
  };
}

function tosAcked(): Values {
  return {
    [CCT_BLOCK_IDS.add_tos_ack]: {
      cct_tos_ack: { type: 'checkboxes', selected_options: [{ value: 'ack' }] },
    },
  };
}

function mergeValues(...parts: Values[]): Values {
  return Object.assign({}, ...parts);
}

function fakeManager(listResult: Array<{ name: string; keyId: string; kind: any; status: string }> = []) {
  return { listTokens: vi.fn(() => listResult) } as any;
}

const GOOD_OAUTH_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-xxxxxxxx',
    refreshToken: 'refreshvalue',
    expiresAt: Date.parse('2026-12-31T00:00:00Z'),
    scopes: ['user:profile', 'user:inference'],
  },
});

describe('validateAddSubmission', () => {
  it('empty name → error keyed by cct_add_name', () => {
    const values = mergeValues(withName(''), withKind('setup_token'), setupTokenValue('sk-ant-oat01-abcdefgh'));
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors).not.toBeNull();
    expect(errors?.[CCT_BLOCK_IDS.add_name]).toBeDefined();
  });

  it('duplicate name → error keyed by cct_add_name', () => {
    const values = mergeValues(withName('cct1'), withKind('setup_token'), setupTokenValue('sk-ant-oat01-abcdefgh'));
    const errors = validateAddSubmission(
      values,
      fakeManager([{ name: 'cct1', keyId: 's1', kind: 'cct', status: 'healthy' }]),
    );
    expect(errors?.[CCT_BLOCK_IDS.add_name]).toMatch(/already in use/);
  });

  it('setup_token non-matching regex → error keyed by cct_add_value', () => {
    const values = mergeValues(withName('ok'), withKind('setup_token'), setupTokenValue('not-a-valid-token'));
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_setup_token_value]).toMatch(/sk-ant-oat01/);
  });

  it('oauth_credentials missing ToS ack → error keyed by cct_add_tos_ack', () => {
    const values = mergeValues(
      withName('ok'),
      withKind('oauth_credentials'),
      oauthBlobValue(GOOD_OAUTH_BLOB),
      // no tosAcked()
    );
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_tos_ack]).toMatch(/Terms/);
  });

  it('oauth_credentials with bad JSON → error keyed by cct_add_oauth_blob', () => {
    const values = mergeValues(withName('ok'), withKind('oauth_credentials'), oauthBlobValue('{not json'), tosAcked());
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_oauth_credentials_blob]).toBeDefined();
  });

  it('oauth_credentials missing user:profile scope → error keyed by cct_add_oauth_blob', () => {
    const noProfileBlob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.parse('2026-12-31T00:00:00Z'),
        scopes: ['user:inference'],
      },
    });
    const values = mergeValues(
      withName('ok'),
      withKind('oauth_credentials'),
      oauthBlobValue(noProfileBlob),
      tosAcked(),
    );
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_oauth_credentials_blob]).toMatch(/user:profile/);
  });

  it('valid setup_token submission → null', () => {
    const values = mergeValues(withName('new-slot'), withKind('setup_token'), setupTokenValue('sk-ant-oat01-abcdefgh'));
    expect(validateAddSubmission(values, fakeManager())).toBeNull();
  });

  it('valid oauth_credentials submission with ack → null', () => {
    const values = mergeValues(
      withName('oauth'),
      withKind('oauth_credentials'),
      oauthBlobValue(GOOD_OAUTH_BLOB),
      tosAcked(),
    );
    expect(validateAddSubmission(values, fakeManager())).toBeNull();
  });
});

describe('parseOAuthBlob', () => {
  it('accepts the nested claudeAiOauth wrapper', () => {
    const creds = parseOAuthBlob(GOOD_OAUTH_BLOB);
    expect(creds?.accessToken).toBe('sk-ant-oat01-xxxxxxxx');
    expect(creds?.scopes).toContain('user:profile');
    expect(creds?.expiresAtMs).toBe(Date.parse('2026-12-31T00:00:00Z'));
  });

  it('accepts the bare inner shape', () => {
    const raw = JSON.stringify({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAtMs: 1234,
      scopes: ['user:profile'],
    });
    const creds = parseOAuthBlob(raw);
    expect(creds?.expiresAtMs).toBe(1234);
  });

  it('rejects missing fields', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'a' } });
    expect(parseOAuthBlob(raw)).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(parseOAuthBlob('{not json')).toBeNull();
  });
});

describe('buildCardFromManager (post-action ephemeral card)', () => {
  it('uses snapshot state so the card reflects persisted per-slot state after Add', async () => {
    const snap = {
      version: 2 as const,
      revision: 2,
      registry: {
        activeKeyId: 'slot-1',
        slots: [
          {
            kind: 'cct' as const,
            source: 'setup' as const,
            keyId: 'slot-1',
            name: 'cct1',
            setupToken: 'sk-ant-oat01-abc',
            createdAt: '2026-04-18T00:00:00Z',
          },
        ],
      },
      state: {
        'slot-1': {
          authState: 'healthy' as const,
          activeLeases: [],
          rateLimitedAt: '2026-04-18T05:00:00Z',
          rateLimitSource: 'response_header' as const,
        },
      },
    };
    const tm = {
      getSnapshot: vi.fn(async () => snap),
      listTokens: vi.fn(() => []),
      getActiveToken: vi.fn(() => null),
    } as any;
    const blocks = await buildCardFromManager(tm);
    expect(tm.getSnapshot).toHaveBeenCalledTimes(1);
    const flat = JSON.stringify(blocks);
    // rate-limit state from the snapshot must surface — not an empty state map.
    expect(flat).toContain('rate-limited');
  });

  it('falls back to listTokens() when getSnapshot throws', async () => {
    const tm = {
      getSnapshot: vi.fn(async () => {
        throw new Error('boom');
      }),
      listTokens: vi.fn(() => [{ keyId: 'slot-2', name: 'cct2', kind: 'cct', status: 'healthy' }]),
      getActiveToken: vi.fn(() => ({ keyId: 'slot-2', name: 'cct2', kind: 'cct' })),
    } as any;
    const blocks = await buildCardFromManager(tm);
    expect(tm.listTokens).toHaveBeenCalled();
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
  });

  // Codex P0 fix #2 — post-action ephemeral card must hide api_key slots
  // from rows AND from the set_active selector, matching the Z-topic
  // `renderCctCard` filter. A stray api_key row would let the user click a
  // token whose runtime path throws (api_key fence in applyToken), leaving
  // them with only `logger.error` as feedback.
  it('T8g: buildCardFromManager hides api_key slot rows + set_active options (Codex P0 fix #2)', async () => {
    const snap = {
      version: 2 as const,
      revision: 2,
      registry: {
        activeKeyId: 'slot-1',
        slots: [
          {
            kind: 'cct' as const,
            source: 'setup' as const,
            keyId: 'slot-1',
            name: 'cct1',
            setupToken: 'sk-ant-oat01-abc',
            createdAt: '2026-04-18T00:00:00Z',
          },
          {
            kind: 'api_key' as const,
            keyId: 'api-1',
            name: 'ops-api',
            value: 'sk-ant-api03-zzz',
            createdAt: '2026-04-18T00:00:00Z',
          },
        ],
      },
      state: {},
    };
    const tm = {
      getSnapshot: vi.fn(async () => snap),
      listTokens: vi.fn(() => []),
      getActiveToken: vi.fn(() => null),
    } as any;
    const blocks = await buildCardFromManager(tm);
    // Tightened assertion (Codex test-review feedback): walk the block tree
    // structurally. A text-fragment check can pass for a leak that reuses the
    // keyId instead of the name, or embeds the api_key into a button value.
    // We walk every node and reject if any string field anywhere references
    // `api-1` (the keyId) or `ops-api` (the name) while the cct slot must
    // still be present.
    type AnyBlock = Record<string, unknown>;
    const collectedStrings: string[] = [];
    const walk = (node: unknown): void => {
      if (node == null) return;
      if (typeof node === 'string') {
        collectedStrings.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node === 'object') {
        for (const v of Object.values(node as AnyBlock)) walk(v);
      }
    };
    walk(blocks);
    // cct slot is rendered.
    expect(collectedStrings.some((s) => s.includes('cct1'))).toBe(true);
    // No string anywhere references the api_key slot (name or keyId), so a
    // leak via button `value`, action_id, or row title all fail this assertion.
    expect(collectedStrings.some((s) => s.includes('ops-api'))).toBe(false);
    expect(collectedStrings.some((s) => s.includes('api-1'))).toBe(false);
    // Hidden-count context line is surfaced so operators still see the
    // api_key slots exist.
    expect(collectedStrings.some((s) => s.includes('1 api_key slots hidden'))).toBe(true);
  });

  it('T8g-ii: buildCardFromManager omits hidden-count line when no api_key slots exist', async () => {
    const snap = {
      version: 2 as const,
      revision: 2,
      registry: {
        activeKeyId: 'slot-1',
        slots: [
          {
            kind: 'cct' as const,
            source: 'setup' as const,
            keyId: 'slot-1',
            name: 'cct1',
            setupToken: 'sk-ant-oat01-abc',
            createdAt: '2026-04-18T00:00:00Z',
          },
        ],
      },
      state: {},
    };
    const tm = {
      getSnapshot: vi.fn(async () => snap),
      listTokens: vi.fn(() => []),
      getActiveToken: vi.fn(() => null),
    } as any;
    const blocks = await buildCardFromManager(tm);
    const flat = JSON.stringify(blocks);
    expect(flat).not.toMatch(/api_key slots hidden/);
  });
});

describe('cct_open_remove routing', () => {
  function makeApp() {
    const handlers = new Map<string, (ctx: any) => Promise<void>>();
    const app = {
      action: (id: string, fn: (ctx: any) => Promise<void>) => {
        handlers.set(id, fn);
      },
      view: () => {
        /* noop */
      },
    } as any;
    return { app, handlers };
  }

  it('open_remove routes to the keyId carried in the button value, not the active slot', async () => {
    const { app, handlers } = makeApp();
    const tm = {
      listTokens: () => [
        { keyId: 'slot-A', name: 'cctA', kind: 'cct', status: 'healthy' },
        { keyId: 'slot-B', name: 'cctB', kind: 'cct', status: 'healthy' },
      ],
      getActiveToken: () => ({ keyId: 'slot-A', name: 'cctA', kind: 'cct' }),
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: {
          activeKeyId: 'slot-A',
          slots: [
            {
              kind: 'cct' as const,
              source: 'setup' as const,
              keyId: 'slot-A',
              name: 'cctA',
              setupToken: '',
              createdAt: '',
            },
            {
              kind: 'cct' as const,
              source: 'setup' as const,
              keyId: 'slot-B',
              name: 'cctB',
              setupToken: '',
              createdAt: '',
            },
          ],
        },
        state: {},
      }),
    } as any;
    // admin-utils is only used by requireAdmin — stub via vi.doMock is heavy;
    // the test manually sets user.id to a well-known admin via mock.
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const openRemove = handlers.get(CCT_ACTION_IDS.remove);
      expect(openRemove).toBeDefined();
      const openedViews: any[] = [];
      const ctx = {
        ack: vi.fn(async () => undefined),
        body: {
          trigger_id: 'T1',
          user: { id: 'admin' },
          actions: [{ value: 'slot-B' }],
        },
        client: {
          views: { open: vi.fn(async (v: any) => openedViews.push(v)) },
        },
        respond: vi.fn(),
      };
      await openRemove?.(ctx);
      expect(openedViews).toHaveLength(1);
      expect(openedViews[0].view.private_metadata).toBe('slot-B');
    } finally {
      spy.mockRestore();
    }
  });
});

// ── T8: api_key validation + attach/detach routing (Z2 + Z3) ──

function apiKeyValue(val: string): Values {
  return {
    [CCT_BLOCK_IDS.add_api_key_value]: {
      cct_api_key_value: { type: 'plain_text_input', value: val },
    },
  };
}

describe('validateAddSubmission — api_key arm (Z3)', () => {
  it('T8a: valid sk-ant-api03- value → null', () => {
    const values = mergeValues(withName('api-1'), withKind('api_key'), apiKeyValue('sk-ant-api03-abcdefghij'));
    expect(validateAddSubmission(values, fakeManager())).toBeNull();
  });

  it('T8a-ii: non-matching value → error keyed by cct_add_api_key_value', () => {
    const values = mergeValues(withName('api-1'), withKind('api_key'), apiKeyValue('not-an-api-key'));
    const errors = validateAddSubmission(values, fakeManager());
    expect(errors?.[CCT_BLOCK_IDS.add_api_key_value]).toMatch(/sk-ant-api03/);
  });
});

describe('attach/detach action routing (Z2)', () => {
  function makeApp() {
    const actionHandlers = new Map<string, (ctx: any) => Promise<void>>();
    const viewHandlers = new Map<string, (ctx: any) => Promise<void>>();
    const app = {
      action: (id: string, fn: (ctx: any) => Promise<void>) => {
        actionHandlers.set(id, fn);
      },
      view: (id: string, fn: (ctx: any) => Promise<void>) => {
        viewHandlers.set(id, fn);
      },
    } as any;
    return { app, actionHandlers, viewHandlers };
  }

  it('T8b: cct_open_attach opens the attach modal when the target is a setup-source cct slot', async () => {
    const { app, actionHandlers } = makeApp();
    const setupSlot = {
      kind: 'cct' as const,
      source: 'setup' as const,
      keyId: 'slot-B',
      name: 'bare',
      setupToken: '',
      createdAt: '',
    };
    const tm = {
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-B', slots: [setupSlot] },
        state: {},
      }),
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const openAttach = actionHandlers.get(CCT_ACTION_IDS.attach);
      expect(openAttach).toBeDefined();
      const openedViews: any[] = [];
      await openAttach?.({
        ack: vi.fn(async () => undefined),
        body: { trigger_id: 'T1', user: { id: 'admin' }, actions: [{ value: 'slot-B' }] },
        client: { views: { open: vi.fn(async (v: any) => openedViews.push(v)) } },
      });
      expect(openedViews).toHaveLength(1);
      expect(openedViews[0].view.private_metadata).toBe('slot-B');
      expect(openedViews[0].view.callback_id).toBe('cct_attach_oauth');
    } finally {
      spy.mockRestore();
    }
  });

  it('T8b-ii: cct_open_attach refuses to open against a legacy-attachment slot', async () => {
    const { app, actionHandlers } = makeApp();
    const legacySlot = {
      kind: 'cct' as const,
      source: 'legacy-attachment' as const,
      keyId: 'slot-L',
      name: 'legacy',
      oauthAttachment: {
        accessToken: 't',
        refreshToken: 'r',
        expiresAtMs: 1,
        scopes: ['user:profile'],
        acknowledgedConsumerTosRisk: true as const,
      },
      createdAt: '',
    };
    const tm = {
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-L', slots: [legacySlot] },
        state: {},
      }),
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const openAttach = actionHandlers.get(CCT_ACTION_IDS.attach);
      const openedViews: any[] = [];
      await openAttach?.({
        ack: vi.fn(async () => undefined),
        body: { trigger_id: 'T1', user: { id: 'admin' }, actions: [{ value: 'slot-L' }] },
        client: { views: { open: vi.fn(async (v: any) => openedViews.push(v)) } },
      });
      expect(openedViews).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('T8c: cct_detach calls TokenManager.detachOAuth(keyId)', async () => {
    const { app, actionHandlers } = makeApp();
    const detachOAuth = vi.fn(async () => undefined);
    const tm = {
      detachOAuth,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-X', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const detach = actionHandlers.get(CCT_ACTION_IDS.detach);
      expect(detach).toBeDefined();
      const ack = vi.fn(async () => undefined);
      await detach?.({
        ack,
        body: {
          user: { id: 'admin' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'slot-X' }],
        },
        client: { chat: { postEphemeral: vi.fn(async () => undefined) } },
      });
      expect(ack).toHaveBeenCalled();
      expect(detachOAuth).toHaveBeenCalledWith('slot-X');
    } finally {
      spy.mockRestore();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // #803 — in-place card update for activate / next / detach
  // ────────────────────────────────────────────────────────────────────

  it('#803: cct_activate_slot uses chat.update in-place (no fresh ephemeral stack-up)', async () => {
    const { app, actionHandlers } = makeApp();
    const applyToken = vi.fn(async () => undefined);
    const tm = {
      applyToken,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: {
          activeKeyId: 'slot-A',
          slots: [
            {
              kind: 'cct' as const,
              source: 'setup' as const,
              keyId: 'slot-B',
              name: 'cctB',
              setupToken: 'sk-ant-oat01-xxxx',
              createdAt: '',
            },
            {
              kind: 'cct' as const,
              source: 'setup' as const,
              keyId: 'slot-A',
              name: 'cctA',
              setupToken: 'sk-ant-oat01-yyyy',
              createdAt: '',
            },
          ],
        },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
      fetchUsageForAllAttached: vi.fn(async () => ({})),
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const tmModule = await import('../../../token-manager');
    const tmSpy = vi.spyOn(tmModule, 'getTokenManager').mockReturnValue(tm);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.activate_slot);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|slot-B' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(applyToken).toHaveBeenCalledWith('slot-B');
      // In-place chat.update on the originating message — NOT a fresh
      // ephemeral stacked on top of the stale card.
      expect(update).toHaveBeenCalledTimes(1);
      expect(postEphemeral).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      tmSpy.mockRestore();
    }
  });

  it('#803: cct_next uses respond({replace_original:true}) on ephemeral surface', async () => {
    const { app, actionHandlers } = makeApp();
    const rotateToNext = vi.fn(async () => ({ keyId: 'slot-A', name: 'cctA' }));
    const tm = {
      rotateToNext,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-A', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.next);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'ephemeral', channel_id: 'C1' },
          actions: [{ value: 'cm:admin|next' }],
        },
        client: { chat: { update, postEphemeral: vi.fn() } },
        respond,
      });
      expect(rotateToNext).toHaveBeenCalledTimes(1);
      // Ephemeral surface uses respond replace_original — NOT chat.update.
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral', replace_original: true }),
      );
      expect(update).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('#803: cct_detach uses chat.update on message surface (no fresh ephemeral)', async () => {
    const { app, actionHandlers } = makeApp();
    const detachOAuth = vi.fn(async () => undefined);
    const tm = {
      detachOAuth,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-X', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
      fetchUsageForAllAttached: vi.fn(async () => ({})),
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const tmModule = await import('../../../token-manager');
    const tmSpy = vi.spyOn(tmModule, 'getTokenManager').mockReturnValue(tm);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.detach);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|slot-X' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(detachOAuth).toHaveBeenCalledWith('slot-X');
      expect(update).toHaveBeenCalledTimes(1);
      expect(postEphemeral).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      tmSpy.mockRestore();
    }
  });

  it('#803: cct_activate_slot rejects invalid action value (no applyToken call)', async () => {
    const { app, actionHandlers } = makeApp();
    const applyToken = vi.fn(async () => undefined);
    const tm = { applyToken, getSnapshot: async () => ({}) as any } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.activate_slot);
      // 'cm:bad|x' — invalid mode triggers decoder rejection.
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:bad|x' }],
        },
        client: { chat: { update: vi.fn(), postEphemeral: vi.fn() } },
        respond: vi.fn(),
      });
      expect(applyToken).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('T8d: attach view_submission validate→ack-first→attachOAuth (happy path) [admin gated #803]', async () => {
    const { app, viewHandlers } = makeApp();
    const attachOAuth = vi.fn(async () => undefined);
    const tm = {
      attachOAuth,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-B', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    // #803 — view submission now has an admin gate. Spy isAdminUser so
    // the test admin user actually flows past the gate.
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const submit = viewHandlers.get('cct_attach_oauth');
      expect(submit).toBeDefined();
      const ack = vi.fn(async () => undefined);
      await submit?.({
        ack,
        body: {
          user: { id: 'admin' },
          container: { channel_id: 'C1' },
          view: {
            private_metadata: 'slot-B',
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
        client: { chat: { postEphemeral: vi.fn(async () => undefined) } },
      });
      // Codex P0 fix #1 — plain ack (not an errors-ack) fires BEFORE the
      // attach mutation so the 3s view_submission budget is never at risk of
      // CAS retries on a slow disk. Ordering is asserted strictly in T8f.
      expect(ack).toHaveBeenCalledWith();
      expect(attachOAuth).toHaveBeenCalledWith(
        'slot-B',
        expect.objectContaining({ accessToken: expect.any(String) }),
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('T8f: attach view_submission acks BEFORE attachOAuth is invoked (Codex P0 fix #1, 3s budget safety)', async () => {
    // Regression test — proves strict ordering: ack must fire BEFORE
    // attachOAuth is invoked, not merely before attachOAuth settles. A
    // regression like `const p = attachOAuth(...); await ack(); await p;`
    // would still satisfy a "ack called while attach pending" assertion
    // but would blow Slack's 3s view_submission budget whenever the mutate
    // hits CAS retries. We catch that by:
    //   (1) recording call order synchronously in both mock bodies;
    //   (2) asserting ack runs while attachOAuth has NOT yet been invoked;
    //   (3) asserting the final call-order log is ['ack', 'attach'].
    const { app, viewHandlers } = makeApp();
    const callOrder: string[] = [];
    let resolveAttach!: () => void;
    const attachGate = new Promise<void>((r) => {
      resolveAttach = r;
    });
    const attachOAuth = vi.fn(async () => {
      callOrder.push('attach');
      await attachGate;
    });
    // Ack records its own call AND asserts attachOAuth has not yet been
    // entered — this is the synchronous ordering contract the 3s budget
    // relies on. If the handler ever regresses to calling attachOAuth first,
    // this inner expect fires and the test fails at the exact crossing.
    const ack = vi.fn(async () => {
      expect(attachOAuth).not.toHaveBeenCalled();
      callOrder.push('ack');
    });
    const tm = {
      attachOAuth,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-B', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    // #803 — view submission admin gate.
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    registerCctActions(app, tm);
    const submit = viewHandlers.get('cct_attach_oauth');
    const handlerPromise = submit?.({
      ack,
      body: {
        user: { id: 'admin' },
        container: { channel_id: 'C1' },
        view: {
          private_metadata: 'slot-B',
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
      client: { chat: { postEphemeral: vi.fn(async () => undefined) } },
    });
    // Drain one microtask round so sync validation + ack have fired, and
    // attachOAuth is awaiting the gate.
    await new Promise((r) => setImmediate(r));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(attachOAuth).toHaveBeenCalledTimes(1);
    // Strict ordering: ack first, attach second.
    expect(callOrder).toEqual(['ack', 'attach']);
    // Release attach so the handler can return cleanly.
    resolveAttach();
    await handlerPromise;
    spy.mockRestore();
  });

  it('T8e: attach view_submission surfaces validation errors (no ack checkbox) as response_action:errors', async () => {
    const { app, viewHandlers } = makeApp();
    const attachOAuth = vi.fn(async () => undefined);
    const tm = { attachOAuth } as any;
    // #803 — view submission admin gate must let this admin user past
    // so the validation-error path is exercised (otherwise we'd ack
    // with an `Admin only` error and miss the validation branch).
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const submit = viewHandlers.get('cct_attach_oauth');
      const ack = vi.fn(async () => undefined);
      await submit?.({
        ack,
        body: {
          user: { id: 'admin' },
          view: {
            private_metadata: 'slot-B',
            state: {
              values: {
                [CCT_BLOCK_IDS.attach_oauth_blob]: {
                  [CCT_ACTION_IDS.attach_oauth_input]: { value: GOOD_OAUTH_BLOB },
                },
                // Intentionally omit the tos_ack block so "ack" is missing.
              },
            },
          },
        },
        client: {},
      });
      expect(attachOAuth).not.toHaveBeenCalled();
      // Single ack call with errors payload keyed by the tos block_id.
      expect(ack).toHaveBeenCalledTimes(1);
      const ackArg = (ack.mock.calls[0] as any[])[0];
      expect(ackArg.response_action).toBe('errors');
      expect(ackArg.errors).toHaveProperty(CCT_BLOCK_IDS.attach_tos_ack);
    } finally {
      spy.mockRestore();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // #803 — view-submission admin gate
  // ────────────────────────────────────────────────────────────────────

  it('#803: cct_add_slot view submit by non-admin → ack with errors, no addSlot called', async () => {
    const { app, viewHandlers } = makeApp();
    const addSlot = vi.fn(async () => undefined);
    const tm = { addSlot, listTokens: () => [] } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(false);
    try {
      registerCctActions(app, tm);
      const submit = viewHandlers.get('cct_add_slot');
      const ack = vi.fn(async () => undefined);
      await submit?.({
        ack,
        body: {
          user: { id: 'random' },
          view: {
            state: {
              values: {
                [CCT_BLOCK_IDS.add_name]: {
                  [CCT_ACTION_IDS.name_input]: { value: 'cct1' },
                },
                [CCT_BLOCK_IDS.add_kind]: {
                  [CCT_ACTION_IDS.kind_radio]: { selected_option: { value: 'setup_token' } },
                },
                [CCT_BLOCK_IDS.add_setup_token_value]: {
                  [CCT_ACTION_IDS.setup_token_input]: { value: 'sk-ant-oat01-abc12345' },
                },
              },
            },
          },
        },
        client: {},
      });
      expect(addSlot).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledTimes(1);
      const ackArg = (ack.mock.calls[0] as any[])[0];
      expect(ackArg.response_action).toBe('errors');
      expect(ackArg.errors).toHaveProperty(CCT_BLOCK_IDS.add_name);
    } finally {
      spy.mockRestore();
    }
  });

  it('#803: cct_remove_slot view submit by non-admin → no removeSlot called', async () => {
    const { app, viewHandlers } = makeApp();
    const removeSlot = vi.fn(async () => ({ pendingDrain: false }));
    const tm = { removeSlot } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(false);
    try {
      registerCctActions(app, tm);
      const submit = viewHandlers.get('cct_remove_slot');
      const ack = vi.fn(async () => undefined);
      await submit?.({
        ack,
        body: {
          user: { id: 'random' },
          view: { private_metadata: 'slot-B' },
        },
        client: { chat: { postMessage: vi.fn() }, conversations: { open: vi.fn() } },
      });
      expect(removeSlot).not.toHaveBeenCalled();
      // Plain ack closes the modal silently for non-admin (defense-in-
      // depth — the UI gate prevented opening this modal in the first
      // place; the handler just refuses to mutate).
      expect(ack).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('#803: cct_attach_oauth view submit by non-admin → ack with errors, no attachOAuth called', async () => {
    const { app, viewHandlers } = makeApp();
    const attachOAuth = vi.fn(async () => undefined);
    const tm = { attachOAuth } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(false);
    try {
      registerCctActions(app, tm);
      const submit = viewHandlers.get('cct_attach_oauth');
      const ack = vi.fn(async () => undefined);
      await submit?.({
        ack,
        body: {
          user: { id: 'random' },
          view: {
            private_metadata: 'slot-B',
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
        client: {},
      });
      expect(attachOAuth).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledTimes(1);
      const ackArg = (ack.mock.calls[0] as any[])[0];
      expect(ackArg.response_action).toBe('errors');
      expect(ackArg.errors).toHaveProperty(CCT_BLOCK_IDS.attach_oauth_blob);
    } finally {
      spy.mockRestore();
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// M1-S4 · Refresh usage button handlers (#641)
// ────────────────────────────────────────────────────────────────────

describe('refresh_usage action handlers (M1-S4)', () => {
  function makeApp() {
    const actionHandlers = new Map<string, (ctx: any) => Promise<void>>();
    const app = {
      action: (id: string, fn: (ctx: any) => Promise<void>) => {
        actionHandlers.set(id, fn);
      },
      view: () => {
        /* noop */
      },
    } as any;
    return { app, actionHandlers };
  }

  it('refresh_usage_all → tm.refreshAllAttachedOAuthTokens({ awaitProfile: true }) called once; ack runs BEFORE TM (3s budget); no usage fetch', async () => {
    // Card v2 follow-up: [Refresh All OAuth Tokens] is a pure token-refresh
    // fan-out. It MUST NOT call fetchUsageForAllAttached / fetchAndStoreUsage
    // — usage re-fetches live on the separate card-level [Refresh] button.
    // `awaitProfile: true` makes the email / rate-limit-tier badges reflect
    // fresh data on the same click.
    const { app, actionHandlers } = makeApp();
    const callOrder: string[] = [];
    const refreshAllAttachedOAuthTokens = vi.fn(async (_opts?: { awaitProfile?: boolean; timeoutMs?: number }) => {
      callOrder.push('tm.refreshAllAttachedOAuthTokens');
      return { 'slot-A': 'ok' } as Record<string, 'ok' | 'error'>;
    });
    const fetchUsageForAllAttached = vi.fn(async () => ({}));
    const fetchAndStoreUsage = vi.fn(async () => null);
    const tm = {
      refreshAllAttachedOAuthTokens,
      fetchUsageForAllAttached,
      fetchAndStoreUsage,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-A', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_all);
      expect(h).toBeDefined();
      const ack = vi.fn(async () => {
        expect(refreshAllAttachedOAuthTokens).not.toHaveBeenCalled();
        callOrder.push('ack');
      });
      await h?.({
        ack,
        body: {
          user: { id: 'admin' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'all' }],
        },
        client: { chat: { postEphemeral: vi.fn(async () => undefined) } },
      });
      expect(ack).toHaveBeenCalled();
      expect(refreshAllAttachedOAuthTokens).toHaveBeenCalledTimes(1);
      const args = refreshAllAttachedOAuthTokens.mock.calls[0][0];
      expect(args?.awaitProfile).toBe(true);
      // No usage fetch was issued — this handler now only refreshes tokens.
      expect(fetchUsageForAllAttached).not.toHaveBeenCalled();
      expect(fetchAndStoreUsage).not.toHaveBeenCalled();
      expect(callOrder.slice(0, 2)).toEqual(['ack', 'tm.refreshAllAttachedOAuthTokens']);
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_all → when every attached slot reports "error", post ephemeral banner instead of re-posting the card', async () => {
    // All-error outcome map surfaces an ephemeral banner so the admin
    // doesn't see a silent no-op. Empty result map (no attached slots)
    // falls through to the normal card-repost path — see the next test.
    const { app, actionHandlers } = makeApp();
    const refreshAllAttachedOAuthTokens = vi.fn(
      async () => ({ 'slot-A': 'error', 'slot-B': 'error' }) as Record<string, 'ok' | 'error'>,
    );
    // #701 — snapshot must agree with `results` keys: the handler
    // classifies starting keyIds against the snapshot, not the raw map.
    const attachedSlots = [
      {
        kind: 'cct' as const,
        source: 'setup' as const,
        keyId: 'slot-A',
        name: 'A',
        setupToken: 'sk-ant-oat01-a',
        createdAt: '2026-04-01T00:00:00Z',
        oauthAttachment: {
          accessToken: 't',
          refreshToken: 'r',
          expiresAtMs: Date.now() + 3_600_000,
          scopes: ['user:profile', 'user:inference'],
          acknowledgedConsumerTosRisk: true as const,
        },
      },
      {
        kind: 'cct' as const,
        source: 'setup' as const,
        keyId: 'slot-B',
        name: 'B',
        setupToken: 'sk-ant-oat01-b',
        createdAt: '2026-04-01T00:00:00Z',
        oauthAttachment: {
          accessToken: 't',
          refreshToken: 'r',
          expiresAtMs: Date.now() + 3_600_000,
          scopes: ['user:profile', 'user:inference'],
          acknowledgedConsumerTosRisk: true as const,
        },
      },
    ];
    const tm = {
      refreshAllAttachedOAuthTokens,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-A', slots: attachedSlots },
        state: {
          'slot-A': { authState: 'healthy', activeLeases: [] },
          'slot-B': { authState: 'healthy', activeLeases: [] },
        },
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_all);
      const ack = vi.fn(async () => undefined);
      await h?.({
        ack,
        body: {
          user: { id: 'admin' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'all' }],
        },
        client: { chat: { postEphemeral } },
      });
      expect(refreshAllAttachedOAuthTokens).toHaveBeenCalledTimes(1);
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      expect(call.channel).toBe('C1');
      expect(call.user).toBe('admin');
      expect(call.text).toBe(REFRESH_BANNERS.allNull);
      expect(call.blocks).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_all → when zero slots are attached, re-render card in-place [#803]', async () => {
    const { app, actionHandlers } = makeApp();
    const refreshAllAttachedOAuthTokens = vi.fn(async () => ({}) as Record<string, 'ok' | 'error'>);
    const tm = {
      refreshAllAttachedOAuthTokens,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: undefined, slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const tmModule = await import('../../../token-manager');
    const tmSpy = vi.spyOn(tmModule, 'getTokenManager').mockReturnValue(tm);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_all);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          // #803 — message-surface body so renderCardInPlace lands on chat.update.
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|refresh_all' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      // Empty starting set → no failures → no banner; renderCardInPlace
      // hits the message surface and chat.update is called.
      expect(update).toHaveBeenCalledTimes(1);
      expect(postEphemeral).not.toHaveBeenCalled();
      const call = update.mock.calls[0]?.[0] as any;
      expect(Array.isArray(call.blocks)).toBe(true);
    } finally {
      spy.mockRestore();
      tmSpy.mockRestore();
    }
  });

  it('refresh_usage_all → when tm throws, outer catch posts ephemeral Refresh-failed toast', async () => {
    const { app, actionHandlers } = makeApp();
    const refreshAllAttachedOAuthTokens = vi.fn(async () => {
      throw new Error('tm blew up');
    });
    // #701 — handler now calls getSnapshot before refreshAllAttached; return
    // a valid empty snapshot so the test still exercises the later throw.
    const getSnapshot = vi.fn(async () => ({
      version: 2 as const,
      revision: 1,
      registry: { slots: [] },
      state: {},
    }));
    const tm = { refreshAllAttachedOAuthTokens, getSnapshot } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_all);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'all' }],
        },
        client: { chat: { postEphemeral } },
      });
      expect(refreshAllAttachedOAuthTokens).toHaveBeenCalledTimes(1);
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      expect(call.text).toBe(REFRESH_BANNERS.outerCatch);
      expect(call.channel).toBe('C1');
      expect(call.user).toBe('admin');
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_all by non-admin → ack only, no TM call', async () => {
    const { app, actionHandlers } = makeApp();
    const refreshAllAttachedOAuthTokens = vi.fn(async () => ({}));
    const tm = { refreshAllAttachedOAuthTokens } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(false);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_all);
      const ack = vi.fn(async () => undefined);
      await h?.({
        ack,
        body: {
          user: { id: 'random' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'all' }],
        },
        client: { chat: { postEphemeral: vi.fn(async () => undefined) } },
      });
      expect(ack).toHaveBeenCalled();
      expect(refreshAllAttachedOAuthTokens).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('REFRESH_BANNERS literal-lock (regression guard)', () => {
  // Tests elsewhere reference `REFRESH_BANNERS.*` by identity — a silent
  // wording change would not fail them. Lock the literals here so copy
  // edits land as an explicit diff in this test.
  it('allNull banner text is locked', () => {
    expect(REFRESH_BANNERS.allNull).toBe(
      ':warning: *Refresh All OAuth Tokens — nothing refreshed* — every attached slot failed to refresh. Check the TokenManager logs for `refreshAllAttachedOAuthTokens` errors or the auth-state of each slot.',
    );
  });
  it('cardNull banner text is locked', () => {
    expect(REFRESH_BANNERS.cardNull).toBe(
      ':warning: *Refresh — all usage fetches were throttled or failed.* Try again in a moment.',
    );
  });
  it('outerCatch banner text is locked', () => {
    expect(REFRESH_BANNERS.outerCatch).toBe(':warning: Refresh failed. Please try again.');
  });
  it('updateFailed banner text is locked', () => {
    expect(REFRESH_BANNERS.updateFailed).toBe(':warning: 카드 갱신 실패. `/cct`를 다시 실행해주세요.');
  });
});

// ────────────────────────────────────────────────────────────────────
// Card v2 follow-up · card-level [Refresh] (cct_refresh_card)
// ────────────────────────────────────────────────────────────────────

describe('refresh_card action handler (card v2 follow-up)', () => {
  function makeApp() {
    const actionHandlers = new Map<string, (ctx: any) => Promise<void>>();
    const app = {
      action: (id: string, fn: (ctx: any) => Promise<void>) => {
        actionHandlers.set(id, fn);
      },
      view: () => {
        /* noop */
      },
    } as any;
    return { app, actionHandlers };
  }

  function tmWithAttachedSlots(keyIds: string[]) {
    return {
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: {
          activeKeyId: keyIds[0],
          slots: keyIds.map((keyId) => ({
            kind: 'cct' as const,
            source: 'setup' as const,
            keyId,
            name: keyId,
            setupToken: 'sk-ant-oat01-xxxx',
            oauthAttachment: {
              accessToken: 't',
              refreshToken: 'r',
              expiresAtMs: Date.now() + 3_600_000,
              scopes: ['user:profile'],
              acknowledgedConsumerTosRisk: true,
            },
            createdAt: '',
          })),
        },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    };
  }

  it('fans out fetchAndStoreUsage(force:true) for each attached cct slot; chat.update in-place on success (message surface) [#803 admin+admin-card]', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async (keyId: string) => ({
      fetchedAt: new Date().toISOString(),
      fiveHour: { utilization: 0.1, resetsAt: new Date().toISOString() },
      _keyId: keyId,
    }));
    const refreshAllAttachedOAuthTokens = vi.fn(async () => ({}));
    const tm = {
      ...tmWithAttachedSlots(['slot-A', 'slot-B']),
      fetchAndStoreUsage,
      refreshAllAttachedOAuthTokens,
      fetchUsageForAllAttached: vi.fn(async () => ({})),
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    (renderCctCard as any).mockClear();
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      expect(h).toBeDefined();
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          // #803 — `cm:admin|refresh_card` so the force path engages
          // (admin actor + admin cardMode = force=true).
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(fetchAndStoreUsage).toHaveBeenCalledTimes(2);
      expect(fetchAndStoreUsage).toHaveBeenCalledWith('slot-A', { force: true });
      expect(fetchAndStoreUsage).toHaveBeenCalledWith('slot-B', { force: true });
      // Card update path uses chat.update on the originating message.
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({
        channel: 'C1',
        ts: 'ts1',
        text: ':key: CCT status',
        blocks: expect.any(Array),
      });
      // Codex P2 follow-up (#679): persistent message surface MUST use
      // renderCctCard so the trailing z_setting_cct_cancel actions row
      // (built by cct-topic, not by buildCardFromManager) is preserved.
      expect(renderCctCard).toHaveBeenCalledTimes(1);
      // #803 — renderCctCard now also receives viewerMode='admin'.
      expect(renderCctCard).toHaveBeenCalledWith({
        userId: 'admin',
        issuedAt: expect.any(Number),
        viewerMode: 'admin',
      });
      const updateCall = update.mock.calls[0]?.[0] as any;
      const blockJson = JSON.stringify(updateCall.blocks);
      expect(blockJson).toContain('z_setting_cct_cancel');
      // No new ephemeral card should be stacked on success.
      expect(postEphemeral).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      // This handler MUST NOT call refreshAllAttachedOAuthTokens.
      expect(refreshAllAttachedOAuthTokens).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to buildCardFromManager when renderCctCard rejects (refresh still updates the card)', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async (keyId: string) => ({
      fetchedAt: new Date().toISOString(),
      fiveHour: { utilization: 0.1, resetsAt: new Date().toISOString() },
      _keyId: keyId,
    }));
    const tm = { ...tmWithAttachedSlots(['slot-A']), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    (renderCctCard as any).mockReset();
    (renderCctCard as any).mockRejectedValueOnce(new Error('renderer blew up'));
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(renderCctCard).toHaveBeenCalledTimes(1);
      // chat.update still fires with the buildCardFromManager fallback so
      // the user sees the refreshed card even when the heavier renderer
      // throws (P2 fallback contract).
      expect(update).toHaveBeenCalledTimes(1);
      const updateCall = update.mock.calls[0]?.[0] as any;
      expect(Array.isArray(updateCall.blocks)).toBe(true);
      // No banner needed — fallback succeeded.
      expect(postEphemeral).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      // Restore the default mock impl for downstream tests.
      (renderCctCard as any).mockImplementation(async () => ({
        text: ':key: CCT (active: none)',
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: ':key: CCT Tokens' } },
          {
            type: 'actions',
            elements: [{ type: 'button', action_id: 'z_setting_cct_cancel', value: 'cancel' }],
          },
        ],
      }));
    }
  });

  it('ephemeral surface MUST NOT call renderCctCard (uses buildCardFromManager — no cancel button needed)', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async (keyId: string) => ({
      fetchedAt: new Date().toISOString(),
      fiveHour: { utilization: 0.1, resetsAt: new Date().toISOString() },
      _keyId: keyId,
    }));
    const tm = { ...tmWithAttachedSlots(['slot-A']), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    (renderCctCard as any).mockClear();
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'ephemeral', channel_id: 'C1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      // Ephemeral surface uses buildCardFromManager output — the cancel
      // button only matters on persistent /cct or /z cct messages.
      expect(renderCctCard).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('when every attached slot returns null, post ephemeral cardNull banner instead of updating the card', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async () => null);
    const tm = { ...tmWithAttachedSlots(['slot-A', 'slot-B']), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(fetchAndStoreUsage).toHaveBeenCalledTimes(2);
      expect(update).not.toHaveBeenCalled();
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      expect(call.text).toBe(REFRESH_BANNERS.cardNull);
      expect(call.blocks).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('when fetchAndStoreUsage throws for all slots, cardNull banner fires (freshCount=0)', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async () => {
      throw new Error('fetch blew up');
    });
    const tm = { ...tmWithAttachedSlots(['slot-A']), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(update).not.toHaveBeenCalled();
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      // Per-slot throws are caught by Promise.allSettled → freshCount=0 →
      // cardNull banner (the outer-catch path only fires if getSnapshot
      // itself throws, which is covered by the next test).
      expect(call.text).toBe(REFRESH_BANNERS.cardNull);
    } finally {
      spy.mockRestore();
    }
  });

  it('when getSnapshot throws, outer-catch posts the outerCatch banner', async () => {
    const { app, actionHandlers } = makeApp();
    const tm = {
      getSnapshot: async () => {
        throw new Error('snapshot failed');
      },
      fetchAndStoreUsage: vi.fn(),
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(update).not.toHaveBeenCalled();
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      expect(call.text).toBe(REFRESH_BANNERS.outerCatch);
    } finally {
      spy.mockRestore();
    }
  });

  it('empty attached-slot list updates the card in-place (freshCount=0 with keyIds=0 is not a failure)', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn();
    const tm = { ...tmWithAttachedSlots([]), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(fetchAndStoreUsage).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
      const call = update.mock.calls[0]?.[0] as any;
      expect(call.channel).toBe('C1');
      expect(call.ts).toBe('ts1');
      expect(Array.isArray(call.blocks)).toBe(true);
      expect(postEphemeral).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('#803: non-admin click on admin-mode card → non-force fetch, in-place re-render preserves admin cardMode', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn();
    const fetchUsageForAllAttached = vi.fn(async () => ({ 'slot-A': null }));
    const tm = {
      ...tmWithAttachedSlots(['slot-A']),
      fetchAndStoreUsage,
      fetchUsageForAllAttached,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    // isAdminUser is called once for actor (non-admin = false). The
    // renderCctCard mock factory in this file is wired so it doesn't
    // call isAdminUser internally — we control the spy behavior.
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(false);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    (renderCctCard as any).mockClear();
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      const ack = vi.fn(async () => undefined);
      await h?.({
        ack,
        body: {
          user: { id: 'random' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          // admin-mode card stamp → preserved across viewer (#803 spec Q1=A).
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(ack).toHaveBeenCalled();
      // Force fetch is gated to (admin actor) AND (admin cardMode).
      // Non-admin actor on admin-mode card → non-force path (uses
      // fetchUsageForAllAttached, not fetchAndStoreUsage{force:true}).
      expect(fetchAndStoreUsage).not.toHaveBeenCalled();
      expect(fetchUsageForAllAttached).toHaveBeenCalledTimes(1);
      // Card is re-rendered in place — preserving admin cardMode.
      expect(update).toHaveBeenCalledTimes(1);
      // renderCctCard called with viewerMode='admin' (from the
      // tagged button value), NOT readonly (which would be the
      // actor-derived fallback).
      expect(renderCctCard).toHaveBeenCalledWith({
        userId: 'random',
        issuedAt: expect.any(Number),
        viewerMode: 'admin',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('#803: non-admin click on readonly-mode card → non-force fetch, readonly re-render', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn();
    const fetchUsageForAllAttached = vi.fn(async () => ({ 'slot-A': null }));
    const tm = {
      ...tmWithAttachedSlots(['slot-A']),
      fetchAndStoreUsage,
      fetchUsageForAllAttached,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(false);
    const update = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    (renderCctCard as any).mockClear();
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'random' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:readonly|refresh_card' }],
        },
        client: { chat: { update, postEphemeral: vi.fn() } },
        respond,
      });
      expect(fetchAndStoreUsage).not.toHaveBeenCalled();
      expect(fetchUsageForAllAttached).toHaveBeenCalledTimes(1);
      expect(renderCctCard).toHaveBeenCalledWith({
        userId: 'random',
        issuedAt: expect.any(Number),
        viewerMode: 'readonly',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('#803: admin click on readonly-mode card → non-force fetch (force-gate denies), admin actor cannot promote readonly card to force', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn();
    const fetchUsageForAllAttached = vi.fn(async () => ({ 'slot-A': null }));
    const tm = {
      ...tmWithAttachedSlots(['slot-A']),
      fetchAndStoreUsage,
      fetchUsageForAllAttached,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:readonly|refresh_card' }],
        },
        client: { chat: { update, postEphemeral: vi.fn() } },
        respond: vi.fn(),
      });
      // Force gate requires BOTH admin actor AND admin cardMode.
      // Readonly cardMode → non-force path even when actor is admin.
      expect(fetchAndStoreUsage).not.toHaveBeenCalled();
      expect(fetchUsageForAllAttached).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('#803: legacy value (no cm: prefix) forces force=false even for admin actor', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn();
    const fetchUsageForAllAttached = vi.fn(async () => ({ 'slot-A': null }));
    const tm = {
      ...tmWithAttachedSlots(['slot-A']),
      fetchAndStoreUsage,
      fetchUsageForAllAttached,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          // legacy form — pre-#803 button. cardMode unknown → safer to throttle.
          actions: [{ value: 'refresh_card' }],
        },
        client: { chat: { update, postEphemeral: vi.fn() } },
        respond: vi.fn(),
      });
      expect(fetchAndStoreUsage).not.toHaveBeenCalled();
      expect(fetchUsageForAllAttached).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('#803: throttle-all-null on non-force path → in-place card with "Cached usage · refresh limited" banner', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchUsageForAllAttached = vi.fn(async () => ({ 'slot-A': null, 'slot-B': null }));
    const tm = {
      ...tmWithAttachedSlots(['slot-A', 'slot-B']),
      fetchAndStoreUsage: vi.fn(),
      fetchUsageForAllAttached,
    } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(false);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'random' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:readonly|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond: vi.fn(),
      });
      // Throttle-all-null on non-force path → still re-renders the
      // card in place; throttle banner is prepended as the first
      // section block (NOT a cardNull ephemeral fallback).
      expect(update).toHaveBeenCalledTimes(1);
      expect(postEphemeral).not.toHaveBeenCalled();
      const call = update.mock.calls[0]?.[0] as any;
      const banner = (call.blocks as Array<{ text?: { text?: string } }>)[0]?.text?.text ?? '';
      expect(banner).toContain('Cached usage');
      expect(banner).toContain('refresh limited');
    } finally {
      spy.mockRestore();
    }
  });

  it('refreshes ephemeral surface via response_url replace_original', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async (keyId: string) => ({
      fetchedAt: new Date().toISOString(),
      fiveHour: { utilization: 0.1, resetsAt: new Date().toISOString() },
      _keyId: keyId,
    }));
    const tm = { ...tmWithAttachedSlots(['slot-A']), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'ephemeral', channel_id: 'C1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith({
        response_type: 'ephemeral',
        replace_original: true,
        text: ':key: CCT status',
        blocks: expect.any(Array),
      });
      // Ephemeral surface MUST NOT use chat.update (no message_ts available).
      expect(update).not.toHaveBeenCalled();
      // No fallback banner on success.
      expect(postEphemeral).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to updateFailed banner when container is missing entirely', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async (keyId: string) => ({
      fetchedAt: new Date().toISOString(),
      fiveHour: { utilization: 0.1, resetsAt: new Date().toISOString() },
      _keyId: keyId,
    }));
    const tm = { ...tmWithAttachedSlots(['slot-A']), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          // Channel-only fallback so the banner has somewhere to land.
          channel: { id: 'C1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(update).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      expect(call.text).toBe(REFRESH_BANNERS.updateFailed);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to updateFailed banner when chat.update rejects', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async (keyId: string) => ({
      fetchedAt: new Date().toISOString(),
      fiveHour: { utilization: 0.1, resetsAt: new Date().toISOString() },
      _keyId: keyId,
    }));
    const tm = { ...tmWithAttachedSlots(['slot-A']), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async () => {
      throw new Error('msg too old');
    });
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'message', channel_id: 'C1', message_ts: 'ts1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      expect(call.text).toBe(REFRESH_BANNERS.updateFailed);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to updateFailed banner when respond rejects on ephemeral surface', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async (keyId: string) => ({
      fetchedAt: new Date().toISOString(),
      fiveHour: { utilization: 0.1, resetsAt: new Date().toISOString() },
      _keyId: keyId,
    }));
    const tm = { ...tmWithAttachedSlots(['slot-A']), fetchAndStoreUsage } as any;
    const adminUtils = await import('../../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const update = vi.fn(async (_arg: any) => undefined);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    const respond = vi.fn(async () => {
      throw new Error('response_url expired');
    });
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_card);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { type: 'ephemeral', channel_id: 'C1' },
          actions: [{ value: 'cm:admin|refresh_card' }],
        },
        client: { chat: { update, postEphemeral } },
        respond,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      expect(call.text).toBe(REFRESH_BANNERS.updateFailed);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('kind_radio flip preserves block_ids across views.update', () => {
  it('both views use the same add_name block_id so typed value is preserved', () => {
    const setupView = buildAddSlotModal('setup_token') as any;
    const oauthView = buildAddSlotModal('oauth_credentials') as any;
    const setupBlockIds = (setupView.blocks as any[]).map((b) => b.block_id);
    const oauthBlockIds = (oauthView.blocks as any[]).map((b) => b.block_id);
    // Stable IDs across the radio flip.
    expect(setupBlockIds).toContain(CCT_BLOCK_IDS.add_name);
    expect(oauthBlockIds).toContain(CCT_BLOCK_IDS.add_name);
    expect(setupBlockIds).toContain(CCT_BLOCK_IDS.add_kind);
    expect(oauthBlockIds).toContain(CCT_BLOCK_IDS.add_kind);
    // Conditional blocks differ as expected.
    expect(setupBlockIds).toContain(CCT_BLOCK_IDS.add_setup_token_value);
    expect(setupBlockIds).not.toContain(CCT_BLOCK_IDS.add_oauth_credentials_blob);
    expect(oauthBlockIds).toContain(CCT_BLOCK_IDS.add_oauth_credentials_blob);
    expect(oauthBlockIds).toContain(CCT_BLOCK_IDS.add_tos_ack);
  });
});
