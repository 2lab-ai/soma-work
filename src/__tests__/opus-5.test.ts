/**
 * Locks the Claude Opus 5 (2026-08-26) release wiring AND the one-way
 * Opus-family default migration that ships with it.
 *
 * Two separate contracts live here:
 *
 *   1. Selection surface — `claude-opus-5` / `claude-opus-5[1m]` are real
 *      allow-list entries, the "latest opus" aliases (`opus`, `opus[1m]`)
 *      point at the `[1m]` variant (the spelling whose Claude Code denominator
 *      is 1M, which the 750k auto-compact default needs), and the model
 *      registry prices it at the Opus tier instead of falling through to the
 *      Sonnet-tier fallback. Pricing evidence: llmux `src/pricing.rs:103-105`
 *      maps `claude-opus-5` to `OPUS_TIER` ($5 in / $25 out / $0.5 cache-read).
 *
 *   2. Migration — every persisted USER DEFAULT in the opus family (4.5 … 4.8,
 *      bare and `[1m]`, plus a bare Opus 5) converges on `claude-opus-5[1m]`.
 *      There is exactly ONE authority for this: the startup one-shot
 *      `forceMigrateOpus1m`, which runs before the settings store loads.
 *      `UserSettingsStore` deliberately does NOT re-run the rewrite — a second
 *      migration path would re-migrate a user who deliberately picked an older
 *      opus generation after the one-shot had already run. These tests drive
 *      the real startup function and then load the store on top of it, which
 *      is the production order.
 *
 *      Non-opus users are untouched, the write happens only when a value
 *      actually changed, and loading the store afterwards does not rewrite the
 *      file. Active SESSIONS are explicitly out of scope: `sessions.json` is
 *      never opened by either path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forceMigrateOpus1m } from '../deploy/force-migrate-opus-1m';
import { getModelSpec, resolveAutoCompactTokens, resolveContextWindow } from '../metrics/model-registry';
import {
  AVAILABLE_MODELS,
  coerceToAvailableModel,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  migrateOpusDefaultModel,
  OPUS_DEFAULT_MIGRATION_TARGET,
  UserSettingsStore,
} from '../user-settings-store';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeStore(): UserSettingsStore {
  return new UserSettingsStore(makeTempDir('opus5-test-'));
}

function writeSettings(dir: string, settings: Record<string, Record<string, unknown>>): void {
  fs.writeFileSync(path.join(dir, 'user-settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}

function readSettings(dir: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'user-settings.json'), 'utf8'));
}

describe('opus-5 — release wiring', () => {
  it('lists both Opus 5 variants in AVAILABLE_MODELS', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-opus-5');
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-opus-5[1m]');
  });

  it('the "latest opus" aliases point at the 1M variant', () => {
    // Both `opus` and `opus[1m]` land on `[1m]`: the bare spelling cannot reach
    // the requested 750k auto-compact default because Claude Code sizes it at
    // 200k. The version-pinned `opus-5` alias still selects the bare id for a
    // user who deliberately wants the 200k profile for this one session.
    expect(MODEL_ALIASES.opus).toBe('claude-opus-5[1m]');
    expect(MODEL_ALIASES['opus[1m]']).toBe('claude-opus-5[1m]');
    expect(MODEL_ALIASES['opus-5']).toBe('claude-opus-5');
    expect(MODEL_ALIASES['opus-5[1m]']).toBe('claude-opus-5[1m]');
  });

  it('older generations keep their pinned aliases (no silent upgrade)', () => {
    expect(MODEL_ALIASES['opus-4.8']).toBe('claude-opus-4-8');
    expect(MODEL_ALIASES['opus-4.8[1m]']).toBe('claude-opus-4-8[1m]');
    expect(MODEL_ALIASES['opus-4.7']).toBe('claude-opus-4-7');
    expect(MODEL_ALIASES['opus-4.6']).toBe('claude-opus-4-6');
    expect(MODEL_ALIASES['opus-4.5']).toBe('claude-opus-4-5-20251101');
  });

  it('does NOT change DEFAULT_MODEL (still the gpt flagship)', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
  });

  it('resolves and coerces both spellings', () => {
    const store = makeStore();
    expect(store.resolveModelInput('opus')).toBe('claude-opus-5[1m]');
    expect(store.resolveModelInput('claude-opus-5')).toBe('claude-opus-5');
    expect(store.resolveModelInput('claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
    expect(coerceToAvailableModel('claude-opus-5')).toBe('claude-opus-5');
    expect(coerceToAvailableModel('claude-opus-5[1M]')).toBe('claude-opus-5[1m]');
  });

  it('renders curated display labels for both variants', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('claude-opus-5')).toBe('Opus 5');
    expect(store.getModelDisplayName('claude-opus-5[1m]')).toBe('Opus 5 (1M)');
  });
});

describe('opus-5 — model-registry pricing (Opus tier, not the Sonnet fallback)', () => {
  it('prices claude-opus-5 at the Opus tier for both spellings', () => {
    // llmux src/pricing.rs:103-105 puts `claude-opus-5` in OPUS_TIER
    // (5.0 / 25.0 / 0.5 / 6.25). Without a soma matcher the id fell through to
    // FALLBACK_SPEC — Sonnet rates — understating every Opus 5 turn's cost.
    for (const id of ['claude-opus-5', 'claude-opus-5[1m]']) {
      const spec = getModelSpec(id);
      expect(spec.pricing.inputPerMTok).toBe(5);
      expect(spec.pricing.outputPerMTok).toBe(25);
      expect(spec.pricing.cacheReadPerMTok).toBe(0.5);
      expect(spec.pricing.cache5minWritePerMTok).toBe(6.25);
      expect(spec.pricing.cache1hrWritePerMTok).toBe(10);
      expect(spec.maxOutput).toBe(128_000);
      // `ModelSpec.contextWindow` is the registry's LEGACY family-level field
      // (substring matching cannot see the `[1m]` opt-in), matching the
      // `opus-4-8` row. The effective window is asserted against
      // `resolveModelProfile` further down, where bare Opus 5 is 200k.
      expect(spec.contextWindow).toBe(1_000_000);
    }
  });

  it('does not shadow the 4.x opus rows (substring matching is first-wins)', () => {
    expect(getModelSpec('claude-opus-4-5-20251101').pricing.outputPerMTok).toBe(25);
    expect(getModelSpec('claude-sonnet-4-6').pricing.outputPerMTok).toBe(15);
  });
});

describe('opus-5 — context profile (suffix is the 1M opt-in)', () => {
  it('[1m] gets 1M + the 750k auto-compact default; the bare id gets 200k', () => {
    expect(resolveContextWindow('claude-opus-5[1m]')).toBe(1_000_000);
    expect(resolveAutoCompactTokens('claude-opus-5[1m]')).toBe(750_000);
    expect(resolveContextWindow('claude-opus-5')).toBe(200_000);
    expect(resolveAutoCompactTokens('claude-opus-5')).toBeUndefined();
  });
});

describe('migrateOpusDefaultModel — the pure transform', () => {
  it('maps every opus-family spelling to claude-opus-5[1m]', () => {
    expect(OPUS_DEFAULT_MIGRATION_TARGET).toBe('claude-opus-5[1m]');
    for (const id of [
      'claude-opus-4-5-20251101',
      'claude-opus-4-6',
      'claude-opus-4-6[1m]',
      'claude-opus-4-7',
      'claude-opus-4-7[1m]',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-5',
      'claude-opus-5[1m]',
    ]) {
      expect(migrateOpusDefaultModel(id)).toBe('claude-opus-5[1m]');
    }
  });

  it('returns non-opus values BYTE-identical (not merely equivalent)', () => {
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-sol[1m]', 'claude-sonnet-4-6', 'claude-fable-5[1m]', 'grok-4.6']) {
      expect(migrateOpusDefaultModel(id)).toBe(id);
    }
    // Whitespace/case oddities in a NON-opus value are left exactly as found —
    // normalisation is `coerceToAvailableModel`'s job, not the migration's.
    expect(migrateOpusDefaultModel('  GPT-5.6-Sol  ')).toBe('  GPT-5.6-Sol  ');
  });

  it('is idempotent and total (non-string input passes through)', () => {
    expect(migrateOpusDefaultModel(migrateOpusDefaultModel('claude-opus-4-7'))).toBe('claude-opus-5[1m]');
    expect(migrateOpusDefaultModel(undefined as unknown as string)).toBeUndefined();
  });
});

describe('opus-5 — disk-backed user-default migration (startup one-shot, then store load)', () => {
  const SEEDED = {
    U_OPUS_45: { userId: 'U_OPUS_45', defaultModel: 'claude-opus-4-5-20251101', persona: 'a', accepted: true },
    U_OPUS_46: { userId: 'U_OPUS_46', defaultModel: 'claude-opus-4-6', persona: 'b', accepted: true },
    U_OPUS_46_1M: { userId: 'U_OPUS_46_1M', defaultModel: 'claude-opus-4-6[1m]', persona: 'c', accepted: true },
    U_OPUS_47: { userId: 'U_OPUS_47', defaultModel: 'claude-opus-4-7', persona: 'd', accepted: true },
    U_OPUS_47_1M: { userId: 'U_OPUS_47_1M', defaultModel: 'claude-opus-4-7[1m]', persona: 'e', accepted: true },
    U_OPUS_48: { userId: 'U_OPUS_48', defaultModel: 'claude-opus-4-8', persona: 'f', accepted: true },
    U_OPUS_48_1M: { userId: 'U_OPUS_48_1M', defaultModel: 'claude-opus-4-8[1m]', persona: 'g', accepted: true },
    U_OPUS_5: { userId: 'U_OPUS_5', defaultModel: 'claude-opus-5', persona: 'h', accepted: true },
    U_OPUS_5_1M: { userId: 'U_OPUS_5_1M', defaultModel: 'claude-opus-5[1m]', persona: 'i', accepted: true },
    U_SONNET: { userId: 'U_SONNET', defaultModel: 'claude-sonnet-4-6', persona: 'j', accepted: true },
    U_FABLE: { userId: 'U_FABLE', defaultModel: 'claude-fable-5[1m]', persona: 'k', accepted: true },
    U_SOL: { userId: 'U_SOL', defaultModel: 'gpt-5.6-sol', persona: 'l', accepted: true },
    U_HAIKU: { userId: 'U_HAIKU', defaultModel: 'claude-haiku-4-5-20251001', persona: 'm', accepted: true },
  } as const;

  const OPUS_USERS = [
    'U_OPUS_45',
    'U_OPUS_46',
    'U_OPUS_46_1M',
    'U_OPUS_47',
    'U_OPUS_47_1M',
    'U_OPUS_48',
    'U_OPUS_48_1M',
    'U_OPUS_5',
    'U_OPUS_5_1M',
  ];
  const NON_OPUS_USERS = ['U_SONNET', 'U_FABLE', 'U_SOL', 'U_HAIKU'];

  /** Seed the data dir and run the production startup order: migrate, then load. */
  function seed(): string {
    const dir = makeTempDir('opus5-migrate-');
    writeSettings(dir, SEEDED as unknown as Record<string, Record<string, unknown>>);
    return dir;
  }

  it('lands every opus-family default on claude-opus-5[1m]', () => {
    const dir = seed();
    forceMigrateOpus1m({ dataDir: dir });
    const store = new UserSettingsStore(dir);
    for (const u of OPUS_USERS) {
      expect(store.getUserDefaultModel(u)).toBe('claude-opus-5[1m]');
    }
    const onDisk = readSettings(dir);
    for (const u of OPUS_USERS) {
      expect(onDisk[u]?.defaultModel).toBe('claude-opus-5[1m]');
    }
  });

  it('leaves every non-opus user untouched', () => {
    const dir = seed();
    forceMigrateOpus1m({ dataDir: dir });
    const store = new UserSettingsStore(dir);
    for (const u of NON_OPUS_USERS) {
      expect(store.getUserDefaultModel(u)).toBe(SEEDED[u as keyof typeof SEEDED].defaultModel);
    }
    const onDisk = readSettings(dir);
    for (const u of NON_OPUS_USERS) {
      expect(onDisk[u]).toEqual(SEEDED[u as keyof typeof SEEDED]);
    }
  });

  it('changes ONLY the defaultModel field on migrated users', () => {
    const dir = seed();
    forceMigrateOpus1m({ dataDir: dir });
    const onDisk = readSettings(dir);
    for (const u of OPUS_USERS) {
      const before = { ...SEEDED[u as keyof typeof SEEDED] } as Record<string, unknown>;
      const after = { ...onDisk[u] };
      expect(after.defaultModel).toBe('claude-opus-5[1m]');
      delete before.defaultModel;
      delete after.defaultModel;
      expect(after).toEqual(before);
    }
  });

  it('loading the store on top of the migration does not rewrite the file', () => {
    // The migrated ids are all allow-list members, so the store's coercion
    // pass finds nothing to change and must leave the bytes alone. A rewrite
    // here would mean the store disagrees with the migration target.
    const dir = seed();
    forceMigrateOpus1m({ dataDir: dir });
    const file = path.join(dir, 'user-settings.json');
    const afterMigration = fs.readFileSync(file, 'utf8');

    new UserSettingsStore(dir);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterMigration);

    new UserSettingsStore(dir);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterMigration);
  });

  // -------------------------------------------------------------------------
  // Same-boot visibility. `src/index.ts:14` statically imports
  // `user-settings-store`, so the `userSettingsStore` singleton runs its load
  // during module evaluation — BEFORE `main()` reaches `forceMigrateOpus1m`.
  // Without a reload the migrated file is on disk but the process that wrote
  // it keeps serving the pre-migration defaults from memory until the next
  // boot: the first deployed process hands out `claude-opus-4-7` while
  // `user-settings.json` already says `claude-opus-5[1m]`.
  // -------------------------------------------------------------------------
  it('reproduces the stale-memory window: a store loaded BEFORE the migration is stale', () => {
    const dir = seed();
    const store = new UserSettingsStore(dir); // stands in for the import-time load
    expect(store.getUserDefaultModel('U_OPUS_47')).toBe('claude-opus-4-7');

    forceMigrateOpus1m({ dataDir: dir }); // main() migration — disk only

    expect(readSettings(dir).U_OPUS_47?.defaultModel).toBe('claude-opus-5[1m]');
    // The defect being fixed: disk and memory disagree inside one process.
    expect(store.getUserDefaultModel('U_OPUS_47')).toBe('claude-opus-4-7');
  });

  it('reloadSettings() closes the window in the SAME boot', () => {
    const dir = seed();
    const store = new UserSettingsStore(dir);
    const applied = forceMigrateOpus1m({ dataDir: dir });
    expect(applied.status).toBe('applied');

    store.reloadSettings();

    for (const u of OPUS_USERS) {
      expect(store.getUserDefaultModel(u)).toBe('claude-opus-5[1m]');
    }
    for (const u of NON_OPUS_USERS) {
      expect(store.getUserDefaultModel(u)).toBe(SEEDED[u as keyof typeof SEEDED].defaultModel);
    }
  });

  it('reloadSettings() re-reads from disk without rewriting the file', () => {
    // A READ seam: it reruns the existing load path and must not become a
    // second writer racing the migration it follows.
    const dir = seed();
    const store = new UserSettingsStore(dir);
    forceMigrateOpus1m({ dataDir: dir });
    const file = path.join(dir, 'user-settings.json');
    const afterMigration = fs.readFileSync(file, 'utf8');

    store.reloadSettings();

    expect(fs.readFileSync(file, 'utf8')).toBe(afterMigration);
  });

  it('reloadSettings() replaces state rather than merging it', () => {
    const dir = seed();
    const store = new UserSettingsStore(dir);
    writeSettings(dir, { U_SOL: { userId: 'U_SOL', defaultModel: 'gpt-5.6-sol', persona: 'l', accepted: true } });

    store.reloadSettings();

    expect(store.listUsers()).toEqual(['U_SOL']);
  });

  it('the store does NOT re-migrate a deliberate post-migration downgrade', () => {
    // Single authority: once the one-shot has run, a user who picks
    // `opus-4.6` keeps it across restarts. A second rewrite inside the store
    // would silently overrule that choice on every boot.
    const dir = seed();
    forceMigrateOpus1m({ dataDir: dir });
    const store = new UserSettingsStore(dir);
    store.setUserDefaultModel('U_OPUS_47', 'claude-opus-4-6');

    const reloaded = new UserSettingsStore(dir);
    expect(reloaded.getUserDefaultModel('U_OPUS_47')).toBe('claude-opus-4-6');
  });

  it('never opens or rewrites sessions.json', () => {
    const dir = seed();
    const sessionsFile = path.join(dir, 'sessions.json');
    // Sentinel: an ACTIVE session pinned to an old opus id. Sessions keep the
    // model they were started with — only the user DEFAULT migrates.
    const sentinel = JSON.stringify({ 'C1:171.1': { model: 'claude-opus-4-7[1m]' } }, null, 2);
    fs.writeFileSync(sessionsFile, sentinel, 'utf8');
    const mtimeBefore = fs.statSync(sessionsFile).mtimeMs;

    forceMigrateOpus1m({ dataDir: dir });
    new UserSettingsStore(dir);

    expect(fs.readFileSync(sessionsFile, 'utf8')).toBe(sentinel);
    expect(fs.statSync(sessionsFile).mtimeMs).toBe(mtimeBefore);
  });

  it('does not write the settings file at all when there is nothing to migrate', () => {
    const dir = makeTempDir('opus5-nochange-');
    writeSettings(dir, {
      U1: { userId: 'U1', defaultModel: 'gpt-5.6-sol', accepted: true, defaultEffort: 'xhigh' },
    });
    const file = path.join(dir, 'user-settings.json');
    const before = fs.readFileSync(file, 'utf8');

    forceMigrateOpus1m({ dataDir: dir });
    new UserSettingsStore(dir);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
