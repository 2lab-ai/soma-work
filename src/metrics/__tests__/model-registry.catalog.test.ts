/**
 * `resolveContextWindow` × llmux model catalog overlay.
 *
 * Contract: catalog windows apply ONLY to non-claude catalog groups (grok,
 * codex, future). Every claude-id resolution stays byte-identical to the
 * pre-catalog rules ([1m] suffix → native-1M → 200k fallback), and gpt ids
 * keep their hardcoded registry windows (their regex rules run first).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { modelCatalog } from '../../model-catalog';
import { resolveContextWindow } from '../model-registry';

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

describe('resolveContextWindow — catalog overlay', () => {
  it('resolves grok-4.5 to its catalog window (500k) when seeded', () => {
    modelCatalog.__testSeed([GROK]);
    expect(resolveContextWindow('grok-4.5')).toBe(500_000);
  });

  it('falls back to 200k for grok-4.5 when the catalog is empty', () => {
    expect(resolveContextWindow('grok-4.5')).toBe(200_000);
  });

  it('ignores catalog entries in the claude group (opt-in contract preserved)', () => {
    // Even if llmux ever advertises a bare claude id with a big window, the
    // harness must keep the [1m] opt-in contract: bare claude ids stay 200k.
    modelCatalog.__testSeed([
      { id: 'claude-opus-4-8', aliases: [], name: 'Opus 4.8', efforts: [], max_context: 1_000_000, group: 'claude' },
    ]);
    expect(resolveContextWindow('claude-opus-4-8')).toBe(200_000);
  });

  it('keeps existing claude rules byte-identical with the catalog seeded', () => {
    modelCatalog.__testSeed([GROK]);
    expect(resolveContextWindow('claude-opus-4-8')).toBe(200_000); // bare → 200k
    expect(resolveContextWindow('claude-opus-4-8[1m]')).toBe(1_000_000); // suffix opt-in
    expect(resolveContextWindow('claude-fable-5')).toBe(1_000_000); // native 1M
  });

  it('keeps gpt windows on the hardcoded registry values (regex rules run first)', () => {
    modelCatalog.__testSeed([
      GROK,
      { id: 'gpt-5.6', aliases: [], name: 'GPT-5.6', efforts: [], max_context: 400_000, group: 'codex' },
    ]);
    expect(resolveContextWindow('gpt-5.6-sol')).toBe(372_000);
    expect(resolveContextWindow('gpt-5.5')).toBe(275_000);
  });

  it('ignores null / non-positive catalog windows', () => {
    modelCatalog.__testSeed([{ ...GROK, max_context: null }]);
    expect(resolveContextWindow('grok-4.5')).toBe(200_000);
  });
});
