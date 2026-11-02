import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../user-settings-store', () => {
  const store: Record<string, string | undefined> = {};
  const layouts: Record<string, unknown> = { UTHEME: { v: 1, thread: { mode: 'theme' } } };
  return {
    THEME_NAMES: { default: 'Default', compact: 'Compact', minimal: 'Minimal' },
    userSettingsStore: {
      getUserSessionTheme: (u: string) => store[u] ?? 'default',
      getUserDashboardLayout: (u: string) => layouts[u] ?? { v: 1 },
      setUserSessionTheme: (u: string, v: string | undefined) => {
        store[u] = v;
      },
      resolveThemeInput: (raw: string) => {
        const lower = (raw ?? '').toLowerCase();
        if (['default', 'compact', 'minimal'].includes(lower)) return lower;
        if (['reset', 'none', 'off'].includes(lower)) return 'reset';
        return null;
      },
    },
  };
});

import { applyTheme, createThemeTopicBinding, renderThemeCard } from '../theme-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  }
  return out;
}

describe('theme-topic.renderThemeCard', () => {
  it('lists default, compact, minimal and a reset button', async () => {
    const { blocks, text } = await renderThemeCard({ userId: 'U1', issuedAt: 1 });
    expect(text).toContain('Theme');
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_theme_set_default');
    expect(ids).toContain('z_setting_theme_set_compact');
    expect(ids).toContain('z_setting_theme_set_minimal');
    expect(ids).toContain('z_setting_theme_set_reset');
    expect(ids).toContain('z_setting_theme_cancel');
  });
});

describe('theme-topic.applyTheme', () => {
  it('sets a valid theme', async () => {
    const r = await applyTheme({ userId: 'U1', value: 'compact' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Compact');
  });

  it('says where the thread header is set while the thread card follows the task card (.prd/21 §5)', async () => {
    const r = await applyTheme({ userId: 'U1', value: 'compact' });
    expect(r.description).toContain('스레드 카드');
    expect(r.description).toContain('서버 슬랙 테마');
    // A user whose thread card is the server's theme gets the theme on the header: no note.
    const t = await applyTheme({ userId: 'UTHEME', value: 'compact' });
    expect(t.description).not.toContain('스레드 카드');
  });

  it('reset restores default', async () => {
    const r = await applyTheme({ userId: 'U1', value: 'reset' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('기본값');
  });

  it('rejects unknown theme', async () => {
    const r = await applyTheme({ userId: 'U1', value: 'xxx' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Unknown');
  });
});

describe('createThemeTopicBinding', () => {
  it('exposes topic + apply + renderCard', () => {
    const b = createThemeTopicBinding();
    expect(b.topic).toBe('theme');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
  });
});
