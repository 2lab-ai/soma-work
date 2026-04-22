/**
 * Unit coverage for the view-submission validator and the view-update
 * contract on the kind radio. The full Bolt registration (`registerCctActions`)
 * is covered by integration in the wiring test; here we focus on the
 * validation surface and the stability of block_ids across a kind flip.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildCardFromManager,
  parseOAuthBlob,
  REFRESH_BANNERS,
  registerCctActions,
  validateAddSubmission,
} from './actions';
import { buildAddSlotModal } from './builder';
import { CCT_ACTION_IDS, CCT_BLOCK_IDS } from './views';

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

describe('cct_open_remove / cct_open_rename routing', () => {
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
    const adminUtils = await import('../../admin-utils');
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

  it('open_rename rejects (no view opens) when value is not a known keyId', async () => {
    const { app, handlers } = makeApp();
    const tm = {
      listTokens: () => [{ keyId: 'slot-A', name: 'cctA', kind: 'cct', status: 'healthy' }],
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
          ],
        },
        state: {},
      }),
    } as any;
    const adminUtils = await import('../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const openRename = handlers.get(CCT_ACTION_IDS.rename);
      const openedViews: any[] = [];
      const ctx = {
        ack: vi.fn(async () => undefined),
        body: {
          trigger_id: 'T1',
          user: { id: 'admin' },
          actions: [{ value: 'slot-UNKNOWN' }],
        },
        client: {
          views: { open: vi.fn(async (v: any) => openedViews.push(v)) },
        },
        respond: vi.fn(),
      };
      await openRename?.(ctx);
      expect(openedViews).toHaveLength(0);
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
    const adminUtils = await import('../../admin-utils');
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
    const adminUtils = await import('../../admin-utils');
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
    const adminUtils = await import('../../admin-utils');
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

  it('T8d: attach view_submission validate→ack-first→attachOAuth (happy path)', async () => {
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
  });

  it('T8e: attach view_submission surfaces validation errors (no ack checkbox) as response_action:errors', async () => {
    const { app, viewHandlers } = makeApp();
    const attachOAuth = vi.fn(async () => undefined);
    const tm = { attachOAuth } as any;
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

  it('refresh_usage_all → tm.fetchUsageForAllAttached({ timeoutMs }) called once WITHOUT force; ack runs BEFORE TM (3s budget)', async () => {
    // Ordering contract mirrors T8f on view_submission: ack MUST land before
    // the TM call starts, not merely before it settles. Regressing to
    // `const p = tm.fetch(...); await ack(); await p;` would still satisfy
    // "ack called" but blow Slack's 3s action-ack budget whenever the
    // Anthropic fan-out stalls. The inner `expect` inside the ack mock fires
    // at the exact crossing.
    //
    // Force contract (#644 review 4146267530 Finding #2 + autonomous fix):
    // `fetchUsageForAllAttached` does NOT forward `force` to per-slot calls
    // (see `token-manager.ts:1359-1369` and `token-manager.test.ts:1667`).
    // Passing `{ force: true }` here was dead weight — the call-site now
    // omits `force` entirely and this test locks the omission so a future
    // plumbing refactor can't silently reintroduce force for the fan-out.
    const { app, actionHandlers } = makeApp();
    const callOrder: string[] = [];
    const fetchUsageForAllAttached = vi.fn(async (_opts?: { force?: boolean; timeoutMs?: number }) => {
      callOrder.push('tm.fetchUsageForAllAttached');
      return {} as Record<string, unknown>;
    });
    const tm = {
      fetchUsageForAllAttached,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-A', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_all);
      expect(h).toBeDefined();
      const ack = vi.fn(async () => {
        // At the moment ack is invoked, the TM fan-out MUST NOT have started.
        expect(fetchUsageForAllAttached).not.toHaveBeenCalled();
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
      expect(fetchUsageForAllAttached).toHaveBeenCalledTimes(1);
      const args = fetchUsageForAllAttached.mock.calls[0][0];
      // `force` must NOT be passed at all — stricter than `force !== true`
      // so a regression adding `{ force: false }` also fires.
      expect(args).not.toHaveProperty('force');
      expect(typeof args?.timeoutMs).toBe('number');
      // Strict ordering — ack first, TM second.
      expect(callOrder.slice(0, 2)).toEqual(['ack', 'tm.fetchUsageForAllAttached']);
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_all → when every attached slot returns null, post ephemeral banner instead of re-posting the card', async () => {
    // #644 review 4146267530 Finding #2 Option A — all-null result map
    // surfaces an ephemeral banner so the admin doesn't see a silent
    // no-op. Empty result map (no attached slots) falls through to the
    // normal card-repost path — see the next test.
    const { app, actionHandlers } = makeApp();
    const fetchUsageForAllAttached = vi.fn(async () => ({ 'slot-A': null, 'slot-B': null }));
    const tm = {
      fetchUsageForAllAttached,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'slot-A', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../admin-utils');
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
      expect(fetchUsageForAllAttached).toHaveBeenCalledTimes(1);
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      // Banner path: top-level `text` equals the shared constant, no `blocks`.
      expect(call.channel).toBe('C1');
      expect(call.user).toBe('admin');
      expect(call.text).toBe(REFRESH_BANNERS.allNull);
      expect(call.blocks).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_all → when zero slots are attached, re-post the card normally (empty map is not "all failed")', async () => {
    // Empty input map is NOT "all failed" — it just means no attached
    // slots exist to fetch. The handler should re-post the normal card
    // (which renders the "No CCT slots configured" section).
    const { app, actionHandlers } = makeApp();
    const fetchUsageForAllAttached = vi.fn(async () => ({}) as Record<string, null>);
    const tm = {
      fetchUsageForAllAttached,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: undefined, slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../admin-utils');
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
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      // Card repost path carries a `blocks` array (Block Kit).
      expect(Array.isArray(call.blocks)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_slot → tm.fetchAndStoreUsage(keyId, { force: true }) called once; ack runs BEFORE TM (3s budget)', async () => {
    const { app, actionHandlers } = makeApp();
    const callOrder: string[] = [];
    // #644 round 4 — return a non-null usage snapshot so this test exercises
    // the success-path (card repost). The null-branch ephemeral banner is
    // locked separately below so this test keeps its "happy path ack-order"
    // scope and doesn't accidentally double-cover the failure branch.
    const fetchAndStoreUsage = vi.fn(async () => {
      callOrder.push('tm.fetchAndStoreUsage');
      return {
        fetchedAt: new Date('2026-04-21T00:00:00Z').toISOString(),
        fiveHour: { utilization: 0.1, resetsAt: new Date('2026-04-21T05:00:00Z').toISOString() },
      };
    });
    const tm = {
      fetchAndStoreUsage,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'cct1', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_slot);
      expect(h).toBeDefined();
      const ack = vi.fn(async () => {
        expect(fetchAndStoreUsage).not.toHaveBeenCalled();
        callOrder.push('ack');
      });
      await h?.({
        ack,
        body: {
          user: { id: 'admin' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'cct1' }],
        },
        client: { chat: { postEphemeral: vi.fn(async () => undefined) } },
      });
      expect(ack).toHaveBeenCalled();
      expect(fetchAndStoreUsage).toHaveBeenCalledTimes(1);
      expect(fetchAndStoreUsage).toHaveBeenCalledWith('cct1', expect.objectContaining({ force: true }));
      expect(callOrder.slice(0, 2)).toEqual(['ack', 'tm.fetchAndStoreUsage']);
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_slot → when fetchAndStoreUsage returns null, post ephemeral banner instead of re-posting the card', async () => {
    // #644 round 4 Option A — mirrors the all-null branch in refresh_usage_all.
    // A single-slot force-refresh that resolves to `null` (throttled or fetch
    // failure) must surface an ephemeral banner so the admin sees that the
    // click did nothing visible. Silently re-posting the unchanged card would
    // look identical to a dead button.
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async () => null);
    const tm = {
      fetchAndStoreUsage,
      getSnapshot: async () => ({
        version: 2 as const,
        revision: 1,
        registry: { activeKeyId: 'cct1', slots: [] },
        state: {},
      }),
      listTokens: () => [],
      getActiveToken: () => null,
    } as any;
    const adminUtils = await import('../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_slot);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'cct1' }],
        },
        client: { chat: { postEphemeral } },
      });
      expect(fetchAndStoreUsage).toHaveBeenCalledTimes(1);
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      // Banner path: top-level `text` equals the shared constant, no `blocks`.
      expect(call.channel).toBe('C1');
      expect(call.user).toBe('admin');
      expect(call.text).toBe(REFRESH_BANNERS.slotNull);
      expect(call.blocks).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_all → when tm throws, outer catch posts ephemeral Refresh-failed toast', async () => {
    // #644 round 4 Option A — the outer try/catch previously only logged;
    // the admin saw a dead button on a genuinely broken TM. Lock the
    // toast-on-throw branch so a future refactor can't drop the feedback.
    const { app, actionHandlers } = makeApp();
    const fetchUsageForAllAttached = vi.fn(async () => {
      throw new Error('tm blew up');
    });
    const tm = { fetchUsageForAllAttached } as any;
    const adminUtils = await import('../../admin-utils');
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
      expect(fetchUsageForAllAttached).toHaveBeenCalledTimes(1);
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const call = postEphemeral.mock.calls[0]?.[0] as any;
      expect(call.text).toBe(REFRESH_BANNERS.outerCatch);
      expect(call.channel).toBe('C1');
      expect(call.user).toBe('admin');
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_slot → when tm throws, outer catch posts ephemeral Refresh-failed toast', async () => {
    // #644 round 4 Option A — mirrors the Refresh-all outer-catch toast.
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async () => {
      throw new Error('tm blew up');
    });
    const tm = { fetchAndStoreUsage } as any;
    const adminUtils = await import('../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
    const postEphemeral = vi.fn(async (_arg: any) => undefined);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_slot);
      await h?.({
        ack: vi.fn(async () => undefined),
        body: {
          user: { id: 'admin' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'cct1' }],
        },
        client: { chat: { postEphemeral } },
      });
      expect(fetchAndStoreUsage).toHaveBeenCalledTimes(1);
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
    const fetchUsageForAllAttached = vi.fn(async () => ({}));
    const tm = { fetchUsageForAllAttached } as any;
    const adminUtils = await import('../../admin-utils');
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
      expect(fetchUsageForAllAttached).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh_usage_slot by non-admin → ack only, no TM call', async () => {
    const { app, actionHandlers } = makeApp();
    const fetchAndStoreUsage = vi.fn(async () => null);
    const tm = { fetchAndStoreUsage } as any;
    const adminUtils = await import('../../admin-utils');
    const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(false);
    try {
      registerCctActions(app, tm);
      const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_slot);
      const ack = vi.fn(async () => undefined);
      await h?.({
        ack,
        body: {
          user: { id: 'random' },
          container: { channel_id: 'C1' },
          actions: [{ value: 'cct1' }],
        },
        client: { chat: { postEphemeral: vi.fn(async () => undefined) } },
      });
      expect(ack).toHaveBeenCalled();
      expect(fetchAndStoreUsage).not.toHaveBeenCalled();
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
