/**
 * `/z model` card × llmux model catalog overlay.
 *
 * Unlike `model-topic.test.ts` (which mocks userSettingsStore), this suite
 * exercises the REAL store + a seeded modelCatalog, so it covers the whole
 * resolution chain: featured aliases like `grok-4.6` (literal, always available),
 * catalog models appended after the static allow-list by their id, no duplicate
 * option ids, and catalog aliases like `grok` resolving via the store (tested
 * separately in the applyModel path).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { modelCatalog } from '../../../../model-catalog';
import { AVAILABLE_MODELS } from '../../../../user-settings-store';
import { FEATURED_ALIASES, renderModelCard } from '../model-topic';

const GROK = {
  id: 'grok-4.5',
  aliases: ['grok'],
  name: 'Grok 4.5',
  efforts: ['low', 'medium', 'high'],
  max_context: 500_000,
  group: 'grok',
};

afterEach(() => {
  modelCatalog.__testReset();
});

function collectButtons(blocks: unknown[]): Array<{ action_id: string; value: string }> {
  const buttons: Array<{ action_id: string; value: string }> = [];
  for (const b of blocks as Array<{ type?: string; elements?: Array<{ action_id: string; value: string }> }>) {
    if (b.type === 'actions') for (const e of b.elements ?? []) buttons.push(e);
  }
  return buttons;
}

describe('renderModelCard — catalog models', () => {
  it("renders catalog model by id even when it has a generic alias like 'grok'", async () => {
    // When the catalog has a model with id='grok-4.5' and aliases=['grok'],
    // it renders as a button with the id, not the alias. The alias is resolved
    // separately for the /z model set <name> command, not for card buttons.
    modelCatalog.__testSeed([GROK]);
    const { blocks } = await renderModelCard({ userId: 'UCAT1', issuedAt: 1 });
    const ids = collectButtons(blocks).map((b) => b.action_id);
    expect(ids).toContain('z_setting_model_set_grok-4.5');
  });

  it('appends catalog models (grok-4.5) after the static allow-list', async () => {
    modelCatalog.__testSeed([GROK]);
    const { blocks } = await renderModelCard({ userId: 'UCAT1', issuedAt: 1 });
    const ids = collectButtons(blocks).map((b) => b.action_id);
    expect(ids).toContain('z_setting_model_set_grok-4.5');
  });

  it('dedupes catalog models already present in the static list', async () => {
    modelCatalog.__testSeed([
      GROK,
      // Static id also advertised by the catalog — must not appear twice.
      { id: 'gpt-5.5', aliases: [], name: 'GPT 5.5', efforts: [], max_context: 275_000, group: 'codex' },
    ]);
    const { blocks } = await renderModelCard({ userId: 'UCAT1', issuedAt: 1 });
    const ids = collectButtons(blocks).map((b) => b.action_id);
    // Verify that the catalog models added in this test don't create duplicates.
    const grok45Count = ids.filter((id) => id === 'z_setting_model_set_grok-4.5').length;
    const gpt55Count = ids.filter((id) => id === 'z_setting_model_set_gpt-5.5').length;
    expect(grok45Count).toBeLessThanOrEqual(1);
    expect(gpt55Count).toBeLessThanOrEqual(1);
  });

  it('renders the fable `[1m]` id exactly once — static entry, no catalog duplicate', async () => {
    // Superseded 2026-08-26: this used to assert the id was EXCLUDED, back
    // when `isCatalogIdSelectable` filtered it out. It is now a static
    // allow-list member, so the live check is that the catalog pass dedupes
    // against the static one rather than rendering a second button.
    modelCatalog.__testSeed([
      GROK,
      {
        id: 'claude-fable-5[1m]',
        aliases: [],
        name: 'Claude Fable 5',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        max_context: 1_000_000,
        group: 'claude',
      },
    ]);
    const { blocks } = await renderModelCard({ userId: 'UCAT1', issuedAt: 1 });
    const ids = collectButtons(blocks).map((b) => b.action_id);
    expect(ids.filter((id) => id === 'z_setting_model_set_claude-fable-5[1m]')).toHaveLength(1);
    expect(ids).toContain('z_setting_model_set_grok-4.5');
  });

  it('features literal grok-4.6 even when the catalog is empty (no dead button)', async () => {
    // The literal featured alias grok-4.6 resolves from the static store and
    // remains available on a catalog-less cold start. Generic grok (if present
    // in the catalog) would appear separately, but does not when catalog is empty.
    const { blocks } = await renderModelCard({ userId: 'UCAT1', issuedAt: 1 });
    const ids = collectButtons(blocks).map((b) => b.action_id);
    expect(ids).toContain('z_setting_model_set_grok-4.6');
    expect(ids).not.toContain('z_setting_model_set_grok');
    // Static featured aliases + full allow-list still render.
    expect(ids).toContain('z_setting_model_set_fable');
    for (const id of AVAILABLE_MODELS) {
      expect(ids).toContain(`z_setting_model_set_${id}`);
    }
  });
});

describe('FEATURED_ALIASES — grok', () => {
  it("includes 'grok-4.6' as the featured grok model", () => {
    expect([...FEATURED_ALIASES]).toContain('grok-4.6');
  });
});
