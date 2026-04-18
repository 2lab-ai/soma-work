import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({ isAdminUser: vi.fn() }));

vi.mock('../../../token-manager', () => {
  type SlotListItem = {
    slotId: string;
    name: string;
    kind: 'setup_token' | 'oauth_credentials';
    status: string;
  };
  const tokens: SlotListItem[] = [
    { slotId: 'slot-1', name: 'cct1', kind: 'setup_token', status: 'healthy' },
    { slotId: 'slot-2', name: 'cct2', kind: 'setup_token', status: 'healthy' },
  ];
  let activeIdx = 0;
  const tm = {
    listTokens: () => [...tokens],
    getActiveToken: () => {
      const t = tokens[activeIdx];
      return t ? { slotId: t.slotId, name: t.name, kind: t.kind } : null;
    },
    applyToken: async (slotId: string) => {
      const i = tokens.findIndex((t) => t.slotId === slotId);
      if (i < 0) throw new Error(`unknown slotId ${slotId}`);
      activeIdx = i;
    },
    rotateToNext: async () => {
      if (tokens.length < 2) return null;
      activeIdx = (activeIdx + 1) % tokens.length;
      const t = tokens[activeIdx];
      return { slotId: t.slotId, name: t.name };
    },
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
