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
  it('features 3 opus aliases as buttons (#648: opus, opus[1m], opus-4.6[1m])', async () => {
    const { blocks } = await renderModelCard({ userId: 'U1', issuedAt: 1 });
    const ids: string[] = [];
    for (const b of blocks as any[]) {
      if (b.type === 'actions') for (const e of b.elements) ids.push(e.action_id);
    }
    // Featured-alias buttons use action_ids encoding the raw alias
    // (ui-builder passes `opt.id` through unchanged; Slack accepts brackets
    // in action_id). Assert via substring match to stay robust against
    // ui-builder id-prefix tweaks.
    const idsBlob = ids.join(' ');
    expect(idsBlob).toContain('opus');
    // Assert on the exact featured-alias ids we care about rather than a
    // global count, so adding/removing a featured alias fails with a
    // meaningful diff instead of a bare numeric mismatch.
    expect(ids.some((id) => id.includes('z_setting_model_set_opus[1m]'))).toBe(true);
    expect(ids.some((id) => id.includes('z_setting_model_set_opus-4.6[1m]'))).toBe(true);
  });
});

describe('model-topic.applyModel', () => {
  it('resolves opus alias to claude-opus-4-7', async () => {
    const r = await applyModel({ userId: 'U1', value: 'opus' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Display:');
    expect(r.description).toContain('claude-opus-4-7');
  });

  it('resolves opus[1m] alias to claude-opus-4-7[1m]', async () => {
    const r = await applyModel({ userId: 'U1', value: 'opus[1m]' });
    expect(r.ok).toBe(true);
    expect(r.description).toContain('claude-opus-4-7[1m]');
  });

  it('errors on legacy sonnet alias (dropped in #648)', async () => {
    const r = await applyModel({ userId: 'U1', value: 'sonnet' });
    expect(r.ok).toBe(false);
  });

  it('errors on unknown alias', async () => {
    const r = await applyModel({ userId: 'U1', value: 'gpt7' });
    expect(r.ok).toBe(false);
  });
});
