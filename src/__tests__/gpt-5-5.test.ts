/**
 * Locks the gpt-5.5 RETIREMENT (2026-11-19, owner instruction).
 *
 * gpt-5.5 was selectable from 2026-07-06. The ChatGPT-account Codex backend
 * has rejected it since 2026-10-14 (llmux probe 2026-11-18: 400 "The
 * 'gpt-5.5' model is not supported when using Codex with a ChatGPT
 * account."; 2lab-ai/llmux#309), so the owner removed it from selection:
 *   - not in AVAILABLE_MODELS, no `gpt5.5` alias, no curated display label;
 *   - typed input is REFUSED with a suggestion, not silently rewritten;
 *   - a stored default / session model of `gpt-5.5` coerces to DEFAULT_MODEL
 *     (opus), even if the llmux catalog still advertises the id;
 *   - the PRICE row stays, so past gpt-5.5 usage keeps its cost when spend
 *     is recalculated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getModelSpec, isRejectedModelInput, resolveModelInputCompatibility } from '../metrics/model-registry';
import { modelCatalog } from '../model-catalog';
import {
  AVAILABLE_MODELS,
  coerceToAvailableModel,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  UserSettingsStore,
} from '../user-settings-store';

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpt55-retired-test-'));
}

afterEach(() => {
  modelCatalog.__testReset();
});

describe('gpt-5.5 — retired from selection (2026-11-19)', () => {
  it('is not in AVAILABLE_MODELS', () => {
    expect(AVAILABLE_MODELS as readonly string[]).not.toContain('gpt-5.5');
  });

  it('has no alias row, and no alias points at it', () => {
    expect(MODEL_ALIASES).not.toHaveProperty('gpt5.5');
    expect(MODEL_ALIASES).not.toHaveProperty('gpt-5.5');
    expect(Object.values(MODEL_ALIASES)).not.toContain('gpt-5.5');
  });

  it('a stored gpt-5.5 coerces to DEFAULT_MODEL (opus)', () => {
    expect(coerceToAvailableModel('gpt-5.5')).toBe(DEFAULT_MODEL);
    expect(coerceToAvailableModel('  GPT-5.5  ')).toBe(DEFAULT_MODEL);
    expect(coerceToAvailableModel('gpt-5.5[1m]')).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe(MODEL_ALIASES.opus);
  });

  it('still coerces to DEFAULT_MODEL when the llmux catalog advertises gpt-5.5', () => {
    // The catalog overlay normally keeps a catalog id alive; a retired id must
    // not be laundered back into persisted state through it.
    modelCatalog.__testSeed([{ id: 'gpt-5.5', aliases: [], name: 'GPT 5.5', efforts: [], group: 'codex' }]);
    expect(coerceToAvailableModel('gpt-5.5')).toBe(DEFAULT_MODEL);
  });

  it('typed `gpt-5.5` / `gpt5.5` is refused with a gpt-5.6-sol suggestion', () => {
    const store = new UserSettingsStore(makeDir());
    for (const input of ['gpt-5.5', ' GPT5.5 ', 'gpt-5.5[1m]']) {
      const resolution = store.resolveModelInputDetailed(input);
      expect(resolution.status).toBe('rejected');
      if (resolution.status !== 'rejected') continue;
      expect(resolution.rejectedReason).toContain('retired on 2026-11-19');
      expect(resolution.suggestedModel).toBe('gpt-5.6-sol');
      expect(store.resolveModelInput(input)).toBeNull();
    }
  });

  it('the suggested replacement is itself selectable', () => {
    const compatibility = resolveModelInputCompatibility('gpt-5.5');
    expect(compatibility && isRejectedModelInput(compatibility)).toBe(true);
    if (!compatibility || !isRejectedModelInput(compatibility)) return;
    expect(AVAILABLE_MODELS as readonly string[]).toContain(compatibility.suggestedModel);
  });

  it('the refusal beats the llmux catalog (no forced re-fetch can revive it)', async () => {
    modelCatalog.__testSeed([{ id: 'gpt-5.5', aliases: ['gpt5.5'], name: 'GPT 5.5', efforts: [], group: 'codex' }]);
    const store = new UserSettingsStore(makeDir());
    expect((await store.resolveModelInputDetailedWithRefresh('gpt-5.5')).status).toBe('rejected');
    expect((await store.resolveModelInputDetailedWithRefresh('gpt5.5')).status).toBe('rejected');
  });

  it('loadSettings rewrites a stored gpt-5.5 default to DEFAULT_MODEL; other choices stay', () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, 'user-settings.json'),
      JSON.stringify({
        U_OLD: { userId: 'U_OLD', defaultModel: 'gpt-5.5', accepted: true },
        U_SOL: { userId: 'U_SOL', defaultModel: 'gpt-5.6-sol', accepted: true },
      }),
    );
    const store = new UserSettingsStore(dir);
    expect(store.getUserDefaultModel('U_OLD')).toBe(DEFAULT_MODEL);
    expect(store.getUserDefaultModel('U_SOL')).toBe('gpt-5.6-sol');
  });
});

describe('gpt-5.5 — price row kept for history', () => {
  it('still resolves the llmux codex rates: $5 in / $30 out / $0.5 cache-read, no cache-write charge', () => {
    const spec = getModelSpec('gpt-5.5');
    expect(spec.pricing.inputPerMTok).toBe(5);
    expect(spec.pricing.outputPerMTok).toBe(30);
    expect(spec.pricing.cacheReadPerMTok).toBe(0.5);
    expect(spec.pricing.cache5minWritePerMTok).toBe(0);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(0);
  });

  it('is its own row, not the fallback (Sonnet) rates', () => {
    const fallback = getModelSpec('definitely-not-a-model');
    expect(getModelSpec('gpt-5.5').pricing).not.toEqual(fallback.pricing);
  });
});
