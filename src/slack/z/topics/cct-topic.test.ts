import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({ isAdminUser: vi.fn() }));

type MockSlot =
  | {
      kind: 'cct';
      source: 'setup';
      keyId: string;
      name: string;
      setupToken: string;
      createdAt: string;
      oauthAttachment?: {
        accessToken: string;
        refreshToken: string;
        expiresAtMs: number;
        scopes: string[];
        acknowledgedConsumerTosRisk: true;
      };
    }
  | {
      kind: 'api_key';
      keyId: string;
      name: string;
      value: string;
      createdAt: string;
    };

// Shared mutable store for the mocked TokenManager so individual tests can
// mutate the slot list (e.g. add api_key slots to exercise Z3 filters).
const mockStore = {
  slots: [] as MockSlot[],
  activeKeyId: undefined as string | undefined,
  state: {} as Record<string, { usage?: unknown }>,
  fetchUsageForAllAttachedCalls: 0,
};

vi.mock('../../../token-manager', () => {
  const tm = {
    listTokens: () => mockStore.slots.map((s) => ({ keyId: s.keyId, name: s.name, kind: s.kind, status: 'healthy' })),
    // Mirror TokenManager.listRuntimeSelectableTokens: filter api_key. Codex
    // P0 fix #2 — applyCct now uses this method to keep text-command fence
    // in sync with render-side filter.
    listRuntimeSelectableTokens: () =>
      mockStore.slots
        .filter((s) => s.kind !== 'api_key')
        .map((s) => ({ keyId: s.keyId, name: s.name, kind: s.kind, status: 'healthy' })),
    getActiveToken: () => {
      const t = mockStore.slots.find((s) => s.keyId === mockStore.activeKeyId);
      return t ? { keyId: t.keyId, name: t.name, kind: t.kind } : null;
    },
    applyToken: async (keyId: string) => {
      const exists = mockStore.slots.some((s) => s.keyId === keyId);
      if (!exists) throw new Error(`unknown keyId ${keyId}`);
      mockStore.activeKeyId = keyId;
    },
    rotateToNext: async () => {
      // Mirror TokenManager.rotateToNext: api_key slots are not
      // runtime-selectable in phase 1 (Z3), so rotation iterates over the
      // cct slots only. Without this filter the mock diverges from the real
      // implementation and T10g would spuriously pass for a regression that
      // let api_key slots be rotated to.
      const cctSlots = mockStore.slots.filter((s) => s.kind === 'cct');
      if (cctSlots.length < 2) return null;
      const activeIdxInCct = cctSlots.findIndex((s) => s.keyId === mockStore.activeKeyId);
      // When the current active is an api_key (or missing), pick the first
      // cct slot — mirrors the real rotateToNext's fallback pick.
      const next = activeIdxInCct >= 0 ? cctSlots[(activeIdxInCct + 1) % cctSlots.length] : cctSlots[0];
      mockStore.activeKeyId = next.keyId;
      return { keyId: next.keyId, name: next.name };
    },
    getSnapshot: async () => ({
      version: 2,
      revision: 1,
      registry: {
        activeKeyId: mockStore.activeKeyId,
        slots: mockStore.slots,
      },
      state: mockStore.state,
    }),
    fetchUsageForAllAttached: async (_opts?: { timeoutMs?: number }) => {
      mockStore.fetchUsageForAllAttachedCalls += 1;
      return {} as Record<string, unknown>;
    },
  };
  return {
    getTokenManager: () => tm,
  };
});

// Reset the mock store to the original two-cct default before each test so
// existing suites (which predate the Z1/Z3 changes) still pass.
function resetMockStore(): void {
  mockStore.slots = [
    {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-1',
      name: 'cct1',
      setupToken: '',
      createdAt: '',
    },
    {
      kind: 'cct',
      source: 'setup',
      keyId: 'slot-2',
      name: 'cct2',
      setupToken: '',
      createdAt: '',
    },
  ];
  mockStore.activeKeyId = 'slot-1';
  mockStore.state = {};
  mockStore.fetchUsageForAllAttachedCalls = 0;
}

import { isAdminUser } from '../../../admin-utils';
import { applyCct, createCctTopicBinding, renderCctCard } from './cct-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  return out;
}

function blocksText(blocks: any[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'section' && b.text?.text) parts.push(b.text.text);
    if (b.type === 'context' && Array.isArray(b.elements)) {
      for (const e of b.elements) if (typeof e?.text === 'string') parts.push(e.text);
    }
    if (b.type === 'header' && b.text?.text) parts.push(b.text.text);
  }
  return parts.join('\n');
}

describe('cct-topic.renderCctCard', () => {
  it('non-admin card omits set/next buttons', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(false);
    const { blocks, text } = await renderCctCard({ userId: 'U1', issuedAt: 1 });
    expect(text).toContain('admin only');
    const ids = actionIds(blocks);
    expect(ids).not.toContain('z_setting_cct_set_next');
    expect(ids).toContain('z_setting_cct_cancel');
  });

  it('admin card lists <name> + next (no `set_` prefix — avoids greedy action-id parser collision)', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(true);
    const { blocks } = await renderCctCard({ userId: 'U1', issuedAt: 2 });
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_cct_set_cct1');
    expect(ids).toContain('z_setting_cct_set_cct2');
    expect(ids).toContain('z_setting_cct_set_next');
    // Regression guard: the legacy double-`set_` form is gone so the
    // `/^z_setting_(.+)_set_(.+)$/` greedy parser can no longer split topic
    // as `cct_set`.
    expect(ids).not.toContain('z_setting_cct_set_set_cct1');
  });

  // ── T9: Z1 — renderCctCard awaits fetchUsageForAllAttached before snapshot ──
  it('T9: renderCctCard invokes fetchUsageForAllAttached on card open', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(true);
    await renderCctCard({ userId: 'U1', issuedAt: 3 });
    expect(mockStore.fetchUsageForAllAttachedCalls).toBe(1);
  });

  // ── T9b: Z3 — api_key slots excluded from set-active (legacy) button set ──
  it('T9b: api_key slots do NOT appear as z_setting_cct_set_<name> buttons', async () => {
    resetMockStore();
    mockStore.slots.push({
      kind: 'api_key',
      keyId: 'api-1',
      name: 'ops-api',
      value: 'sk-ant-api03-abcdefghij',
      createdAt: '',
    });
    vi.mocked(isAdminUser).mockReturnValue(true);
    const { blocks } = await renderCctCard({ userId: 'U1', issuedAt: 4 });
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_cct_set_cct1');
    expect(ids).not.toContain('z_setting_cct_set_ops-api');
  });

  // ── T9c: Z3 — api_key slot rows are hidden from the card ──
  it('T9c: api_key slot rows are not rendered in the card', async () => {
    resetMockStore();
    mockStore.slots.push({
      kind: 'api_key',
      keyId: 'api-2',
      name: 'hidden-api',
      value: 'sk-ant-api03-abcdefghij',
      createdAt: '',
    });
    vi.mocked(isAdminUser).mockReturnValue(true);
    const { blocks } = await renderCctCard({ userId: 'U1', issuedAt: 5 });
    const rendered = blocksText(blocks);
    expect(rendered).toContain('cct1');
    expect(rendered).not.toContain('*hidden-api*');
  });

  // ── T9d: Z3 — hidden-count context line when api_key slots exist ──
  it('T9d: "N api_key slots hidden" context line shown when N >= 1', async () => {
    resetMockStore();
    mockStore.slots.push(
      {
        kind: 'api_key',
        keyId: 'api-3',
        name: 'k3',
        value: 'sk-ant-api03-abcdefghij',
        createdAt: '',
      },
      {
        kind: 'api_key',
        keyId: 'api-4',
        name: 'k4',
        value: 'sk-ant-api03-abcdefghij',
        createdAt: '',
      },
    );
    vi.mocked(isAdminUser).mockReturnValue(true);
    const { blocks } = await renderCctCard({ userId: 'U1', issuedAt: 6 });
    const rendered = blocksText(blocks);
    expect(rendered).toContain('2 api_key slots hidden');
  });

  // ── T9d-ii: no api_key slots → no hidden-count context line ──
  it('T9d-ii: when no api_key slots exist, no "api_key slots hidden" line is rendered', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(true);
    const { blocks } = await renderCctCard({ userId: 'U1', issuedAt: 7 });
    const rendered = blocksText(blocks);
    expect(rendered).not.toMatch(/api_key slots hidden/);
  });
});

describe('cct-topic.applyCct', () => {
  it('non-admin refused', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(false);
    const r = await applyCct({ userId: 'U1', value: 'next' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Admin');
  });

  it('admin can rotate next', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'next' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Rotated');
  });

  it('admin can set by name (legacy `set_<name>` form)', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'set_cct2' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('cct2');
  });

  it('admin can set by name (bare-name form from Block Kit buttons)', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'cct2' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('cct2');
  });

  it('rejects unknown token', async () => {
    resetMockStore();
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'set_doesnotexist' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Unknown');
  });

  // Codex P0 fix #2 — `/z cct set <api_key-name>` must be rejected as
  // Unknown (no applyToken call), with the api_key name absent from the
  // "Available:" hint. This mirrors the text-command fence in
  // cct-handler.ts and the render-side filter in renderCctCard.
  it('T10f: applyCct rejects api_key slot targets and hides them from Available hint', async () => {
    resetMockStore();
    mockStore.slots.push({
      kind: 'api_key',
      keyId: 'api-5',
      name: 'ops-api',
      value: 'sk-ant-api03-abcdefghij',
      createdAt: '',
    });
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'set_ops-api' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Unknown');
    expect(mockStore.activeKeyId).toBe('slot-1');
    expect(r.description ?? '').not.toContain('ops-api');
    expect(r.description ?? '').toContain('cct1');
  });

  it('T10g: applyCct rotateToNext target after api_key add still picks only cct slots', async () => {
    resetMockStore();
    mockStore.slots.push({
      kind: 'api_key',
      keyId: 'api-6',
      name: 'k6',
      value: 'sk-ant-api03-abcdefghij',
      createdAt: '',
    });
    vi.mocked(isAdminUser).mockReturnValue(true);
    // Two cct slots exist (cct1, cct2) + 1 api_key. Rotate twice — a
    // non-filtering rotateToNext would land on the api_key on the second
    // rotation. Tightened (Codex test-review feedback) to assert on
    // `mockStore.activeKeyId` rather than the stringified summary so a
    // regression that labeled the api_key as "Rotated → k6" still fails.
    const r1 = await applyCct({ userId: 'U1', value: 'next' });
    expect(r1.ok).toBe(true);
    expect(mockStore.activeKeyId).toBe('slot-2');
    expect(mockStore.activeKeyId).not.toBe('api-6');
    const r2 = await applyCct({ userId: 'U1', value: 'next' });
    expect(r2.ok).toBe(true);
    // Second rotation MUST skip api-6 and wrap to slot-1; an implementation
    // that lets api_key be the next rotation target corrupts this.
    expect(mockStore.activeKeyId).toBe('slot-1');
    expect(mockStore.activeKeyId).not.toBe('api-6');
    // Final sanity: the active slot must be a cct arm, never api_key.
    const finalActive = mockStore.slots.find((s) => s.keyId === mockStore.activeKeyId);
    expect(finalActive?.kind).toBe('cct');
  });
});

describe('createCctTopicBinding', () => {
  it('exposes topic + apply + renderCard', () => {
    const b = createCctTopicBinding();
    expect(b.topic).toBe('cct');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
  });
});
