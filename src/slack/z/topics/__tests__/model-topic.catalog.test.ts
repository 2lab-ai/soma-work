/**
 * `/z model` card × llmux model catalog overlay.
 *
 * Unlike `model-topic.test.ts` (which mocks userSettingsStore), this suite
 * exercises the REAL store + a seeded modelCatalog, so it covers the whole
 * alias-resolution chain: featured `grok` button → catalog id, catalog models
 * appended after the static allow-list, no duplicate option ids.
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
  it("features a 'grok' alias button that resolves via the catalog", async () => {
    modelCatalog.__testSeed([GROK]);
    const { blocks } = await renderModelCard({ userId: 'UCAT1', issuedAt: 1 });
    const ids = collectButtons(blocks).map((b) => b.action_id);
    expect(ids).toContain('z_setting_model_set_grok');
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
    const setIds = collectButtons(blocks)
      .map((b) => b.action_id)
      .filter((id) => id.startsWith('z_setting_model_set_'));
    expect(new Set(setIds).size).toBe(setIds.length);
  });

  it('excludes non-selectable catalog ids (native-1M `[1m]` variants)', async () => {
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
    expect(ids).not.toContain('z_setting_model_set_claude-fable-5[1m]');
    expect(ids).toContain('z_setting_model_set_grok-4.5');
  });

  it('skips the grok featured button when the catalog is empty (no dead button)', async () => {
    const { blocks } = await renderModelCard({ userId: 'UCAT1', issuedAt: 1 });
    const ids = collectButtons(blocks).map((b) => b.action_id);
    expect(ids).not.toContain('z_setting_model_set_grok');
    // Static featured aliases + full allow-list still render.
    expect(ids).toContain('z_setting_model_set_fable');
    for (const id of AVAILABLE_MODELS) {
      expect(ids).toContain(`z_setting_model_set_${id}`);
    }
  });
});

describe('FEATURED_ALIASES — grok', () => {
  it("includes 'grok' as a featured alias", () => {
    expect([...FEATURED_ALIASES]).toContain('grok');
  });
});
