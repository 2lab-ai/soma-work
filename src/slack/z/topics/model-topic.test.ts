import { describe, expect, it, vi } from 'vitest';
import { applyModel, renderModelCard } from './model-topic';

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
});
