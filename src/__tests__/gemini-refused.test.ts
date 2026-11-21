/**
 * Locks the gemini REFUSAL (2026-11-21).
 *
 * soma-work reaches llmux as Claude Code (Agent SDK), and llmux answers every
 * Claude Code request routed to its gemini group with a local 400 (since
 * 2026-10-15): Google's Antigravity backend refuses them. So a gemini model
 * can only fail here:
 *   - typed input (an id, or a llmux alias such as `argon` / `neon`) is
 *     REFUSED with the reason and the opus default as the suggestion;
 *   - a stored default or session model on a gemini id coerces to
 *     DEFAULT_MODEL, even while the llmux catalog still advertises the row;
 *   - non-gemini catalog aliases (`grok` → grok-4.7) keep resolving.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmuxModelEntry } from '../auth/llmux-client';
import { modelCatalog } from '../model-catalog';
import { AVAILABLE_MODELS, coerceToAvailableModel, DEFAULT_MODEL, UserSettingsStore } from '../user-settings-store';

const row = (id: string, alias: string, name: string, maxContext: number, group: string): LlmuxModelEntry => ({
  id,
  aliases: [alias],
  name,
  efforts: ['low'],
  max_context: maxContext,
  group,
});

// The llmux gemini rows and aliases as of 2026-11-21 (2lab-ai/llmux#313).
const GEMINI_ROWS: LlmuxModelEntry[] = [
  row('gemini-3.8-flash-high[1m]', 'gemini', 'Gemini 3.8 Flash', 1_048_576, 'gemini'),
  row('gemini-4-argon[1m]', 'argon', 'Gemini 4 Argon', 1_048_576, 'gemini'),
  row('gemini-4-neon', 'neon', 'Gemini 4 Neon', 524_288, 'gemini'),
  row('gemini-4-carbon[1m]', 'carbon', 'Gemini 4 Carbon', 1_048_576, 'gemini'),
  row('gemini-4-hydrogen[1m]', 'hydrogen', 'Gemini 4 Hydrogen', 1_048_576, 'gemini'),
];
const GROK_4_7 = row('grok-4.7', 'grok', 'Grok 4.7', 500_000, 'grok');

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-refused-test-'));
}

afterEach(() => {
  modelCatalog.__testReset();
});

describe('gemini models — refused for Claude Code sessions (2026-11-21)', () => {
  it('typed gemini ids and llmux gemini aliases are refused with the opus suggestion', () => {
    modelCatalog.__testSeed([...GEMINI_ROWS, GROK_4_7]);
    const store = new UserSettingsStore(makeDir());
    for (const input of [
      'gemini',
      'argon',
      'neon',
      'carbon',
      'hydrogen',
      'gemini-3.8-flash-high',
      'gemini-4-neon[1m]',
      ' GEMINI-4-ARGON[1M] ',
    ]) {
      const resolution = store.resolveModelInputDetailed(input);
      expect(resolution.status, input).toBe('rejected');
      if (resolution.status !== 'rejected') continue;
      expect(resolution.rejectedReason).toContain('is a Gemini model');
      expect(resolution.suggestedModel).toBe('claude-opus-5-5[1m]');
      expect(store.resolveModelInput(input)).toBeNull();
    }
  });

  it('the suggestion is the opus default and is itself selectable', () => {
    const store = new UserSettingsStore(makeDir());
    const resolution = store.resolveModelInputDetailed('gemini-4-neon');
    expect(resolution.status).toBe('rejected');
    if (resolution.status !== 'rejected') return;
    expect(resolution.suggestedModel).toBe(DEFAULT_MODEL);
    expect(AVAILABLE_MODELS as readonly string[]).toContain(resolution.suggestedModel);
  });

  it('a non-gemini catalog alias still resolves (grok → grok-4.7)', () => {
    modelCatalog.__testSeed([...GEMINI_ROWS, GROK_4_7]);
    const store = new UserSettingsStore(makeDir());
    expect(store.resolveModelInputDetailed('grok')).toEqual({ status: 'accepted', modelId: 'grok-4.7' });
  });

  it('a stale snapshot does not let a new gemini alias through: the forced re-fetch finds it and refuses it', async () => {
    // The snapshot predates `neon`; the first pass says "unknown", the forced
    // llmux re-fetch brings the gemini row, and the retry must refuse it.
    modelCatalog.__testSeed([GROK_4_7]);
    modelCatalog.setFetcher(async () => [...GEMINI_ROWS, GROK_4_7]);
    const store = new UserSettingsStore(makeDir());
    const resolution = await store.resolveModelInputDetailedWithRefresh('neon');
    expect(resolution.status).toBe('rejected');
  });

  it('a stored gemini id coerces to DEFAULT_MODEL, even while the catalog advertises it', () => {
    expect(coerceToAvailableModel('gemini-3.8-flash-high')).toBe(DEFAULT_MODEL);
    modelCatalog.__testSeed(GEMINI_ROWS);
    expect(coerceToAvailableModel('gemini-4-argon[1m]')).toBe(DEFAULT_MODEL);
    expect(coerceToAvailableModel('gemini-4-neon')).toBe(DEFAULT_MODEL);
  });

  it('loadSettings rewrites a stored gemini default to DEFAULT_MODEL; other choices stay', () => {
    modelCatalog.__testSeed([...GEMINI_ROWS, GROK_4_7]);
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, 'user-settings.json'),
      JSON.stringify({
        U_GEM: { userId: 'U_GEM', defaultModel: 'gemini-4-argon[1m]', accepted: true },
        U_GROK: { userId: 'U_GROK', defaultModel: 'grok-4.7', accepted: true },
      }),
    );
    const store = new UserSettingsStore(dir);
    expect(store.getUserDefaultModel('U_GEM')).toBe(DEFAULT_MODEL);
    expect(store.getUserDefaultModel('U_GROK')).toBe('grok-4.7');
  });
});
