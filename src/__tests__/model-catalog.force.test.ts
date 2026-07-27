/**
 * llmux model-catalog force refresh + miss-path re-resolution (T1/T2).
 *
 * SSOT mapping:
 *   T1 — admin `model` must fetch a FRESH catalog (force refresh bypasses the
 *        60s attempt cooldown).
 *   T2 — an unknown model input must trigger a fresh llmux catalog fetch and
 *        re-resolve before erroring (`resolveModelInputWithRefresh`).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmuxModelEntry } from '../auth/llmux-client';
import { modelCatalog } from '../model-catalog';
import { userSettingsStore } from '../user-settings-store';

const GROK: LlmuxModelEntry = {
  id: 'grok-4.5',
  aliases: ['grok'],
  name: 'Grok 4.5',
  efforts: ['low', 'medium', 'high'],
  max_context: 500_000,
  group: 'grok',
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-force-'));
  modelCatalog.__testReset();
  modelCatalog.setSnapshotPathForTests(path.join(tmpDir, 'model-catalog.json'));
});

afterEach(() => {
  modelCatalog.setSnapshotPathForTests(null);
  modelCatalog.__testReset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('modelCatalog.refresh — force option (T1)', () => {
  it('bypasses the 60s attempt cooldown when force is set', async () => {
    const first = vi.fn(async () => [GROK]);
    const r1 = await modelCatalog.refresh(first);
    expect(r1.ok).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);

    // Within the cooldown a normal refresh is skipped…
    const second = vi.fn(async () => [GROK]);
    const r2 = await modelCatalog.refresh(second);
    expect(r2.skipped).toBe(true);
    expect(second).not.toHaveBeenCalled();

    // …but a forced refresh fetches anyway.
    const forced = vi.fn(async () => [GROK]);
    const r3 = await modelCatalog.refresh(forced, { force: true });
    expect(forced).toHaveBeenCalledTimes(1);
    expect(r3.ok).toBe(true);
    expect(r3.skipped).toBeUndefined();
  });

  it('forced refresh still reuses an in-flight fetch (no double fetch)', async () => {
    let release: (models: LlmuxModelEntry[]) => void = () => {};
    const gate = new Promise<LlmuxModelEntry[]>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(() => gate);
    const p1 = modelCatalog.refresh(fetcher, { force: true });
    const p2 = modelCatalog.refresh(fetcher, { force: true });
    release([GROK]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('serial forced refreshes are throttled by a short force cooldown (llmux DoS guard)', async () => {
    const first = vi.fn(async () => [GROK]);
    await modelCatalog.refresh(first, { force: true });
    expect(first).toHaveBeenCalledTimes(1);

    // Immediately forcing again (e.g. repeated typo input) must NOT hammer llmux.
    const second = vi.fn(async () => [GROK]);
    const r = await modelCatalog.refresh(second, { force: true });
    expect(second).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
  });
});

describe('userSettingsStore.resolveModelInputWithRefresh (T2)', () => {
  it('resolves a model unknown to the cache after a fresh llmux fetch', async () => {
    // Cache is empty — sync resolution fails today.
    expect(userSettingsStore.resolveModelInput('grok-4.5')).toBeNull();

    // llmux DOES serve the model: the wired fetcher returns it.
    const fetcher = vi.fn(async () => [GROK]);
    modelCatalog.setFetcher(fetcher);

    const resolved = await userSettingsStore.resolveModelInputWithRefresh('grok-4.5');
    expect(fetcher).toHaveBeenCalled();
    expect(resolved).toBe('grok-4.5');
  });

  it('resolves catalog aliases after a fresh llmux fetch', async () => {
    modelCatalog.setFetcher(async () => [GROK]);
    const resolved = await userSettingsStore.resolveModelInputWithRefresh('grok');
    expect(resolved).toBe('grok-4.5');
  });

  it('returns null when llmux does not serve the model either', async () => {
    modelCatalog.setFetcher(async () => [GROK]);
    const resolved = await userSettingsStore.resolveModelInputWithRefresh('definitely-not-a-model');
    expect(resolved).toBeNull();
  });

  it('does not fetch when the input resolves synchronously', async () => {
    const fetcher = vi.fn(async () => [GROK]);
    modelCatalog.setFetcher(fetcher);
    const resolved = await userSettingsStore.resolveModelInputWithRefresh('opus');
    expect(resolved).toBe('claude-opus-4-8');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
