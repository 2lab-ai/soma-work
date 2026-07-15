/**
 * llmux model-catalog runtime overlay (`src/model-catalog.ts`).
 *
 * The catalog is a stale-while-revalidate overlay over the static
 * AVAILABLE_MODELS allow-list: it makes llmux-served ids (grok-4.5 et al)
 * selectable with correct aliases, display names, effort menus, and context
 * windows — without ever shrinking the static list (Issue #656 guard).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmuxModelEntry } from '../auth/llmux-client';
import { clampEffortToModel, modelCatalog } from '../model-catalog';

const GROK: LlmuxModelEntry = {
  id: 'grok-4.5',
  aliases: ['grok'],
  name: 'Grok 4.5',
  efforts: ['low', 'medium', 'high'],
  max_context: 500_000,
  group: 'grok',
};

const SONNET5: LlmuxModelEntry = {
  id: 'claude-sonnet-5',
  aliases: [],
  name: 'Sonnet 5',
  efforts: [],
  max_context: null,
  group: 'claude',
};

let tmpDir: string;
let snapshotFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
  snapshotFile = path.join(tmpDir, 'model-catalog.json');
  modelCatalog.__testReset();
  modelCatalog.setSnapshotPathForTests(snapshotFile);
});

afterEach(() => {
  modelCatalog.setSnapshotPathForTests(null);
  modelCatalog.__testReset();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('modelCatalog — normalization + resolveInput', () => {
  it('resolves the "grok" alias to the canonical id grok-4.5', () => {
    modelCatalog.__testSeed([GROK]);
    expect(modelCatalog.resolveInput('grok')).toBe('grok-4.5');
  });

  it('resolves the canonical id itself (case-insensitive, trimmed)', () => {
    modelCatalog.__testSeed([GROK]);
    expect(modelCatalog.resolveInput('grok-4.5')).toBe('grok-4.5');
    expect(modelCatalog.resolveInput('  GROK-4.5  ')).toBe('grok-4.5');
    expect(modelCatalog.resolveInput('GROK')).toBe('grok-4.5');
  });

  it('returns null for unknown input', () => {
    modelCatalog.__testSeed([GROK]);
    expect(modelCatalog.resolveInput('gpt7')).toBeNull();
  });

  it('normalizes aliases + efforts to lowercase', () => {
    modelCatalog.__testSeed([{ ...GROK, aliases: ['GROK'], efforts: ['LOW', 'Medium', 'high'] }]);
    expect(modelCatalog.resolveInput('grok')).toBe('grok-4.5');
    expect(modelCatalog.getEffortsFor('grok-4.5')).toEqual(['low', 'medium', 'high']);
  });

  it('filters entries lacking a non-empty string id', async () => {
    const bad = [{ ...GROK, id: '' }, null, { name: 'no id' }] as unknown as LlmuxModelEntry[];
    const result = await modelCatalog.refresh(async () => [GROK, ...bad]);
    expect(result.ok).toBe(true);
    expect(modelCatalog.getModels().map((m) => m.id)).toEqual(['grok-4.5']);
  });

  it('exposes display name / efforts / context window / group accessors', () => {
    modelCatalog.__testSeed([GROK, SONNET5]);
    expect(modelCatalog.getDisplayName('grok-4.5')).toBe('Grok 4.5');
    expect(modelCatalog.getEffortsFor('grok-4.5')).toEqual(['low', 'medium', 'high']);
    expect(modelCatalog.getContextWindowFor('grok-4.5')).toBe(500_000);
    expect(modelCatalog.getGroupFor('grok-4.5')).toBe('grok');
    // null max_context → null window; empty efforts stay empty
    expect(modelCatalog.getContextWindowFor('claude-sonnet-5')).toBeNull();
    expect(modelCatalog.getEffortsFor('claude-sonnet-5')).toEqual([]);
    // unknown id → nulls
    expect(modelCatalog.getDisplayName('nope')).toBeNull();
    expect(modelCatalog.getContextWindowFor('nope')).toBeNull();
    expect(modelCatalog.getGroupFor('nope')).toBeNull();
    expect(modelCatalog.getEffortsFor('nope')).toBeNull();
  });
});

describe('modelCatalog — snapshot persistence', () => {
  it('refresh success persists a snapshot that loadSnapshotSync round-trips', async () => {
    const result = await modelCatalog.refresh(async () => [GROK]);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(snapshotFile)).toBe(true);

    modelCatalog.__testReset();
    modelCatalog.setSnapshotPathForTests(snapshotFile);
    expect(modelCatalog.getModels()).toEqual([]);
    modelCatalog.loadSnapshotSync();
    expect(modelCatalog.getById('grok-4.5')?.name).toBe('Grok 4.5');
    expect(modelCatalog.getContextWindowFor('grok-4.5')).toBe(500_000);
  });

  it('falls back to .bak when the snapshot file is corrupt (never throws)', () => {
    fs.writeFileSync(
      `${snapshotFile}.bak`,
      JSON.stringify({
        fetchedAt: 123,
        models: [
          { id: 'grok-4.5', aliases: ['grok'], name: 'Grok 4.5', efforts: ['low'], maxContext: 500_000, group: 'grok' },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(snapshotFile, '{ this is not json', 'utf8');

    expect(() => modelCatalog.loadSnapshotSync()).not.toThrow();
    expect(modelCatalog.getById('grok-4.5')?.id).toBe('grok-4.5');
  });

  it('keeps a .bak of the previous snapshot on save', async () => {
    await modelCatalog.refresh(async () => [GROK]);
    modelCatalog.__testReset();
    modelCatalog.setSnapshotPathForTests(snapshotFile);
    await modelCatalog.refresh(async () => [GROK, SONNET5]);
    expect(fs.existsSync(`${snapshotFile}.bak`)).toBe(true);
    const bak = JSON.parse(fs.readFileSync(`${snapshotFile}.bak`, 'utf8'));
    expect(bak.models).toHaveLength(1);
    const live = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    expect(live.models).toHaveLength(2);
  });
});

describe('modelCatalog — refresh semantics', () => {
  it('refresh success replaces entries', async () => {
    modelCatalog.__testSeed([SONNET5]);
    const result = await modelCatalog.refresh(async () => [GROK]);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(modelCatalog.getById('grok-4.5')).not.toBeNull();
    expect(modelCatalog.getById('claude-sonnet-5')).toBeNull();
  });

  it('refresh failure keeps current entries (never downgrades) and does not throw', async () => {
    modelCatalog.__testSeed([GROK]);
    const result = await modelCatalog.refresh(async () => {
      throw new Error('llmux unreachable');
    });
    expect(result.ok).toBe(false);
    expect(modelCatalog.getById('grok-4.5')).not.toBeNull();
    expect(fs.existsSync(snapshotFile)).toBe(false);
  });

  it('applies a cooldown between refresh attempts', async () => {
    const first = vi.fn(async () => [GROK]);
    const second = vi.fn(async () => [SONNET5]);
    const r1 = await modelCatalog.refresh(first);
    expect(r1.ok).toBe(true);
    const r2 = await modelCatalog.refresh(second);
    expect(r2.skipped).toBe(true);
    expect(second).not.toHaveBeenCalled();
    expect(modelCatalog.getById('grok-4.5')).not.toBeNull();
  });

  it('dedupes concurrent in-flight refreshes (single fetch)', async () => {
    let release: (models: LlmuxModelEntry[]) => void = () => {};
    const gate = new Promise<LlmuxModelEntry[]>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(() => gate);
    const p1 = modelCatalog.refresh(fetchImpl);
    const p2 = modelCatalog.refresh(fetchImpl);
    release([GROK]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('refresh without any fetcher wired is a safe no-op (tests / non-llmux mode)', async () => {
    modelCatalog.__testSeed([GROK]);
    const result = await modelCatalog.refresh();
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(modelCatalog.getById('grok-4.5')).not.toBeNull();
  });

  it('maybeRefreshInBackground is a no-op while the catalog is fresh', () => {
    modelCatalog.__testSeed([GROK]); // seeds fetchedAt = now
    const fetchImpl = vi.fn(async () => [SONNET5]);
    modelCatalog.maybeRefreshInBackground(fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('clampEffortToModel', () => {
  beforeEach(() => {
    modelCatalog.__testSeed([GROK, SONNET5]);
  });

  it('clamps xhigh → high for grok (highest included ≤ requested)', () => {
    expect(clampEffortToModel('grok-4.5', 'xhigh')).toBe('high');
  });

  it('clamps max → high for grok', () => {
    expect(clampEffortToModel('grok-4.5', 'max')).toBe('high');
  });

  it('passes through an effort the model supports (low → low)', () => {
    expect(clampEffortToModel('grok-4.5', 'low')).toBe('low');
  });

  it('returns the lowest included effort when nothing lower matches', () => {
    modelCatalog.__testSeed([{ ...GROK, efforts: ['medium', 'high'] }]);
    expect(clampEffortToModel('grok-4.5', 'low')).toBe('medium');
  });

  it('passes through unchanged for a model unknown to the catalog', () => {
    expect(clampEffortToModel('claude-opus-4-8', 'xhigh')).toBe('xhigh');
  });

  it('passes through unchanged when the catalog efforts list is empty', () => {
    expect(clampEffortToModel('claude-sonnet-5', 'xhigh')).toBe('xhigh');
  });
});
