import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({ isAdminUser: vi.fn() }));

vi.mock('../../../token-manager', () => {
  const tokens: Array<{ name: string; value: string; cooldownUntil?: Date }> = [
    { name: 'cct1', value: 'sk-abcdef1234567890' },
    { name: 'cct2', value: 'sk-ghijkl0987654321' },
  ];
  let activeIdx = 0;
  return {
    TokenManager: {
      maskToken: (v: string) => `${v.slice(0, 6)}…`,
    },
    tokenManager: {
      getAllTokens: () => [...tokens],
      getActiveToken: () => tokens[activeIdx],
      setActiveToken: (name: string) => {
        const i = tokens.findIndex((t) => t.name === name);
        if (i < 0) return false;
        activeIdx = i;
        return true;
      },
      rotateToNext: () => {
        if (tokens.length < 2) return false;
        activeIdx = (activeIdx + 1) % tokens.length;
        return true;
      },
    },
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
