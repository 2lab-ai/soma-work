import { describe, expect, it, vi } from 'vitest';
import { applyModel, FEATURED_ALIASES, renderModelCard } from './model-topic';

vi.mock('../../../user-settings-store', async () => {
  const actual = await vi.importActual<typeof import('../../../user-settings-store')>('../../../user-settings-store');
  const store: Record<string, string> = {};
  return {
    ...actual,
    userSettingsStore: {
      getUserDefaultModel: (u: string) => store[u] ?? actual.DEFAULT_MODEL,
      setUserDefaultModel: (u: string, m: string) => {
        store[u] = m;
      },
      getModelDisplayName: (id: string) => `Display:${id}`,
      resolveModelInput: (raw: string) => {
        const lower = raw.toLowerCase();
        if ((actual.AVAILABLE_MODELS as readonly string[]).includes(lower)) return lower as any;
        return actual.MODEL_ALIASES[lower] ?? null;
      },
    },
  };
});

describe('model-topic.renderModelCard', () => {
  it('features aliases as buttons (sonnet/opus/haiku)', async () => {
    const { blocks } = await renderModelCard({ userId: 'U1', issuedAt: 1 });
    const ids: string[] = [];
    for (const b of blocks as any[]) {
      if (b.type === 'actions') for (const e of b.elements) ids.push(e.action_id);
    }
    expect(ids).toContain('z_setting_model_set_sonnet');
    expect(ids).toContain('z_setting_model_set_opus');
    expect(ids).toContain('z_setting_model_set_haiku');
  });

  // --- Issue #656 ---

  it('features opus[1m] alias button between opus and haiku', async () => {
    const { blocks } = await renderModelCard({ userId: 'U1', issuedAt: 1 });
    const ids: string[] = [];
    for (const b of blocks as any[]) {
      if (b.type === 'actions') for (const e of b.elements) ids.push(e.action_id);
    }
    expect(ids).toContain('z_setting_model_set_opus[1m]');
  });
});

describe('FEATURED_ALIASES constant', () => {
  it('has the exact SSOT order ["sonnet", "opus", "opus[1m]", "haiku"]', () => {
    // Regression guard against silent removal/reordering of the 1M alias button.
    expect([...FEATURED_ALIASES]).toEqual(['sonnet', 'opus', 'opus[1m]', 'haiku']);
  });
});

describe('model-topic.applyModel', () => {
  it('resolves an alias to a real model id', async () => {
    const r = await applyModel({ userId: 'U1', value: 'sonnet' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Display:');
  });

  it('errors on unknown alias', async () => {
    const r = await applyModel({ userId: 'U1', value: 'gpt7' });
    expect(r.ok).toBe(false);
  });

  // --- Issue #656: end-to-end alias resolution ---

  it('resolves opus[1m] alias to the 1M variant', async () => {
    const r = await applyModel({ userId: 'U1', value: 'opus[1m]' });
    expect(r.ok).toBe(true);
    // Display name is mocked to `Display:<id>` — asserting the real model id is reached.
    expect(r.description).toContain('claude-opus-4-7[1m]');
  });

  it('resolves opus-4.7[1m] dotted alias to the 1M variant', async () => {
    const r = await applyModel({ userId: 'U1', value: 'opus-4.7[1m]' });
    expect(r.ok).toBe(true);
    expect(r.description).toContain('claude-opus-4-7[1m]');
  });

  it('resolves opus-4.6[1m] dotted alias to opus-4-6[1m]', async () => {
    const r = await applyModel({ userId: 'U1', value: 'opus-4.6[1m]' });
    expect(r.ok).toBe(true);
    expect(r.description).toContain('claude-opus-4-6[1m]');
  });

  it('accepts the literal [1m] model id verbatim', async () => {
    const r = await applyModel({ userId: 'U1', value: 'claude-opus-4-7[1m]' });
    expect(r.ok).toBe(true);
    expect(r.description).toContain('claude-opus-4-7[1m]');
  });
});
