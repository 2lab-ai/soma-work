/**
 * Unit coverage for the view-submission validator and the view-update
 * contract on the kind radio. The full Bolt registration (`registerCctActions`)
 * is covered by integration in the wiring test; here we focus on the
 * validation surface and the stability of block_ids across a kind flip.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildCardFromManager, parseOAuthBlob, registerCctActions, validateAddSubmission } from './actions';
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

function withKind(kind: 'setup_token' | 'oauth_credentials', extra: Values = {}): Values {
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

function fakeManager(listResult: Array<{ name: string; slotId: string; kind: any; status: string }> = []) {
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
      fakeManager([{ name: 'cct1', slotId: 's1', kind: 'setup_token', status: 'healthy' }]),
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
      version: 1 as const,
      revision: 2,
      registry: {
        activeSlotId: 'slot-1',
        slots: [
          {
            slotId: 'slot-1',
            name: 'cct1',
            kind: 'setup_token' as const,
            value: 'sk-ant-oat01-abc',
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
      listTokens: vi.fn(() => [{ slotId: 'slot-2', name: 'cct2', kind: 'setup_token', status: 'healthy' }]),
      getActiveToken: vi.fn(() => ({ slotId: 'slot-2', name: 'cct2', kind: 'setup_token' })),
    } as any;
    const blocks = await buildCardFromManager(tm);
    expect(tm.listTokens).toHaveBeenCalled();
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
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

  it('open_remove routes to the slotId carried in the button value, not the active slot', async () => {
    const { app, handlers } = makeApp();
    const tm = {
      listTokens: () => [
        { slotId: 'slot-A', name: 'cctA', kind: 'setup_token', status: 'healthy' },
        { slotId: 'slot-B', name: 'cctB', kind: 'setup_token', status: 'healthy' },
      ],
      getActiveToken: () => ({ slotId: 'slot-A', name: 'cctA', kind: 'setup_token' }),
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

  it('open_rename rejects (no view opens) when value is not a known slotId', async () => {
    const { app, handlers } = makeApp();
    const tm = {
      listTokens: () => [{ slotId: 'slot-A', name: 'cctA', kind: 'setup_token', status: 'healthy' }],
      getActiveToken: () => ({ slotId: 'slot-A', name: 'cctA', kind: 'setup_token' }),
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
