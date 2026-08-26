import { describe, expect, it, vi } from 'vitest';
import { resolveModelInputCompatibility } from '../../../../metrics/model-profile';
import { applyModel, FEATURED_ALIASES, renderModelCard } from '../model-topic';

vi.mock('../../../../user-settings-store', async () => {
  const actual = await vi.importActual<typeof import('../../../../user-settings-store')>(
    '../../../../user-settings-store',
  );
  const store: Record<string, string> = {};
  // Static-only stand-in for the real resolver (no llmux catalog in unit
  // tests). It keeps the REAL rejection branch so the card's error rendering
  // is exercised against production text, not a hand-written string.
  const resolveDetailed = (raw: string): import('../../../../user-settings-store').ModelInputResolution => {
    const lower = raw.toLowerCase().trim();
    const compat = resolveModelInputCompatibility(lower);
    if (compat && 'rejectedReason' in compat) {
      return { status: 'rejected', rejectedReason: compat.rejectedReason, suggestedModel: compat.suggestedModel };
    }
    if ((actual.AVAILABLE_MODELS as readonly string[]).includes(lower)) return { status: 'accepted', modelId: lower };
    const alias = actual.MODEL_ALIASES[lower];
    if (alias) return { status: 'accepted', modelId: alias };
    return { status: 'unknown' };
  };
  return {
    ...actual,
    userSettingsStore: {
      getUserDefaultModel: (u: string) => store[u] ?? actual.DEFAULT_MODEL,
      setUserDefaultModel: (u: string, m: string) => {
        store[u] = m;
      },
      getModelDisplayName: (id: string) => `Display:${id}`,
      resolveModelInput: (raw: string) => {
        const r = resolveDetailed(raw);
        return r.status === 'accepted' ? (r.modelId as any) : null;
      },
      resolveModelInputWithRefresh: async (raw: string) => {
        const r = resolveDetailed(raw);
        return r.status === 'accepted' ? (r.modelId as any) : null;
      },
      resolveModelInputDetailed: resolveDetailed,
      resolveModelInputDetailedWithRefresh: async (raw: string) => resolveDetailed(raw),
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
  it('has the exact SSOT order ["fable", "sonnet", "opus", "opus[1m]", "haiku", "grok-4.6"]', () => {
    // The literal Grok id remains resolvable on a catalog-less cold start.
    expect([...FEATURED_ALIASES]).toEqual(['fable', 'sonnet', 'opus', 'opus[1m]', 'haiku', 'grok-4.6']);
  });

  it('renders the featured grok-4.6 button without a catalog snapshot', async () => {
    const { blocks } = await renderModelCard({ userId: 'U1', issuedAt: 1 });
    const ids: string[] = [];
    for (const b of blocks as any[]) {
      if (b.type === 'actions') for (const e of b.elements) ids.push(e.action_id);
    }
    expect(ids).toContain('z_setting_model_set_grok-4.6');
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

  it('resolves opus[1m] alias to the current-latest 1M variant', async () => {
    const r = await applyModel({ userId: 'U1', value: 'opus[1m]' });
    expect(r.ok).toBe(true);
    // The bare `opus[1m]` alias follows "latest opus" — currently Opus 5.
    // When a new opus generation lands the alias flips here too; that's the
    // single point of update. Version-pinned aliases are covered separately
    // below (opus-4.7[1m], opus-4.6[1m]).
    expect(r.description).toContain('claude-opus-5[1m]');
  });

  it('resolves bare `opus` to the 1M Opus 5 id', async () => {
    const r = await applyModel({ userId: 'U1', value: 'opus' });
    expect(r.ok).toBe(true);
    expect(r.description).toContain('claude-opus-5[1m]');
  });

  it('resolves `fable` to the literal claude-fable-5[1m]', async () => {
    const r = await applyModel({ userId: 'U1', value: 'fable' });
    expect(r.ok).toBe(true);
    expect(r.description).toContain('claude-fable-5[1m]');
  });

  // --- Fake `grok-*[1m]`: rejected, never normalized ---

  it('rejects grok-4.6[1m] VISIBLY and suggests bare grok-4.6', async () => {
    const r = await applyModel({ userId: 'U1', value: 'grok-4.6[1m]' });
    expect(r.ok).toBe(false);
    // The rejection must name the bad id and point at the real one — an
    // "Unknown model" + alias dump would read as a typo and hide the fact
    // that llmux would have forwarded the fake id verbatim to xAI.
    expect(r.summary).toContain('grok-4.6[1m]');
    expect(`${r.summary} ${r.description ?? ''}`).toMatch(/use `grok-4\.6`/i);
    expect(r.description ?? '').not.toContain('Available aliases');
  });

  it('does NOT persist a rejected grok [1m] id as the user default', async () => {
    const { userSettingsStore } = await import('../../../../user-settings-store');
    await applyModel({ userId: 'U_REJECT', value: 'grok-4.6[1m]' });
    expect(userSettingsStore.getUserDefaultModel('U_REJECT')).not.toContain('[1m]');
  });

  it('still reports an ordinary typo as an unknown model with the alias list', async () => {
    const r = await applyModel({ userId: 'U1', value: 'gpt7' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Unknown model');
    expect(r.description).toContain('Available aliases');
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
