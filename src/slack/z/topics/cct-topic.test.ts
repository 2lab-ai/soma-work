import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({ isAdminUser: vi.fn() }));

vi.mock('../../../token-manager', () => {
  type SlotListItem = {
    keyId: string;
    name: string;
    kind: 'cct' | 'api_key';
    status: string;
  };
  const tokens: SlotListItem[] = [
    { keyId: 'slot-1', name: 'cct1', kind: 'cct', status: 'healthy' },
    { keyId: 'slot-2', name: 'cct2', kind: 'cct', status: 'healthy' },
  ];
  let activeIdx = 0;
  const tm = {
    listTokens: () => [...tokens],
    getActiveToken: () => {
      const t = tokens[activeIdx];
      return t ? { keyId: t.keyId, name: t.name, kind: t.kind } : null;
    },
    applyToken: async (keyId: string) => {
      const i = tokens.findIndex((t) => t.keyId === keyId);
      if (i < 0) throw new Error(`unknown keyId ${keyId}`);
      activeIdx = i;
    },
    rotateToNext: async () => {
      if (tokens.length < 2) return null;
      activeIdx = (activeIdx + 1) % tokens.length;
      const t = tokens[activeIdx];
      return { keyId: t.keyId, name: t.name };
    },
    getSnapshot: async () => ({
      version: 2,
      revision: 1,
      registry: {
        activeKeyId: tokens[activeIdx]?.keyId,
        slots: tokens.map((t) => ({
          kind: 'cct' as const,
          source: 'setup' as const,
          keyId: t.keyId,
          name: t.name,
          setupToken: '',
          createdAt: '',
        })),
      },
      state: {},
    }),
  };
  return {
    getTokenManager: () => tm,
  };
});

import { isAdminUser } from '../../../admin-utils';
import { applyCct, createCctTopicBinding, renderCctCard } from './cct-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  return out;
}

describe('cct-topic.renderCctCard', () => {
  it('non-admin card omits set/next buttons', async () => {
    vi.mocked(isAdminUser).mockReturnValue(false);
    const { blocks, text } = await renderCctCard({ userId: 'U1', issuedAt: 1 });
    expect(text).toContain('admin only');
    const ids = actionIds(blocks);
    expect(ids).not.toContain('z_setting_cct_set_next');
    expect(ids).toContain('z_setting_cct_cancel');
  });

  it('admin card lists <name> + next (no `set_` prefix — avoids greedy action-id parser collision)', async () => {
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
});

describe('cct-topic.applyCct', () => {
  it('non-admin refused', async () => {
    vi.mocked(isAdminUser).mockReturnValue(false);
    const r = await applyCct({ userId: 'U1', value: 'next' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Admin');
  });

  it('admin can rotate next', async () => {
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'next' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Rotated');
  });

  it('admin can set by name (legacy `set_<name>` form)', async () => {
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'set_cct2' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('cct2');
  });

  it('admin can set by name (bare-name form from Block Kit buttons)', async () => {
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'cct2' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('cct2');
  });

  it('rejects unknown token', async () => {
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applyCct({ userId: 'U1', value: 'set_doesnotexist' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Unknown');
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
