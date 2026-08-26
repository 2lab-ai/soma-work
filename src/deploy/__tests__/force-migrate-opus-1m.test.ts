/**
 * Startup one-shot migration of persisted `defaultModel` values.
 *
 * 2026-08-26 — the all-user rewrite is RETIRED. The migration used to force
 * EVERY user onto a single target (`gpt-5.6-sol` since 2026-07-10), which
 * silently destroyed each user's own model choice on any host whose marker was
 * missing, corrupt, or written for an older target. The requested behaviour is
 * narrower and is the only behaviour left:
 *
 *   - OPUS-FAMILY defaults only (`claude-opus-*`, bare and `[1m]`, including a
 *     bare `claude-opus-5`) converge on `claude-opus-5[1m]`.
 *   - Every non-opus user is left byte-identical.
 *   - `sessions.json` is never touched — active sessions keep their model.
 *
 * The marker semantics survive unchanged and are still TARGET-AWARE, which is
 * exactly what makes the retirement safe on a live host: the deployed marker
 * records the OLD `gpt-5.6-sol` target, so the first boot after this change
 * re-runs once for the new selective target and then skips forever.
 *
 * The transform itself is not duplicated here — it is
 * `user-settings-store.migrateOpusDefaultModel`, the same function the store's
 * own load path applies, so the two entry points cannot drift.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPUS_DEFAULT_MIGRATION_TARGET } from '../../user-settings-store';
import { forceMigrateOpus1m, OPUS_1M_MIGRATION_MARKER, OPUS_MIGRATION_TARGET } from '../force-migrate-opus-1m';

/** The target this migration shipped with before 2026-08-26. */
const RETIRED_ALL_USER_TARGET = 'gpt-5.6-sol';
/** The 2026-06 first-generation target, still found in old markers. */
const HISTORICAL_OPUS_1M_TARGET = 'claude-opus-4-8[1m]';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opus-1m-mig-'));
}

function writeSettings(dataDir: string, settings: Record<string, Record<string, unknown>>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'user-settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}

function readSettings(dataDir: string): Record<string, Record<string, unknown>> {
  const file = path.join(dataDir, 'user-settings.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeMarker(dataDir: string, target: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, OPUS_1M_MIGRATION_MARKER),
    JSON.stringify({ migratedAt: '2026-06-01T00:00:00.000Z', target, migrated: 3, total: 3 }),
    'utf8',
  );
}

/** A mixed population: 7 opus-family rows + 3 controls that must not move. */
const MIXED_POPULATION: Record<string, Record<string, unknown>> = {
  U_OPUS_45: { userId: 'U_OPUS_45', defaultModel: 'claude-opus-4-5-20251101', accepted: true },
  U_OPUS_46: { userId: 'U_OPUS_46', defaultModel: 'claude-opus-4-6', accepted: true },
  U_OPUS_46_1M: { userId: 'U_OPUS_46_1M', defaultModel: 'claude-opus-4-6[1m]', accepted: true },
  U_OPUS_47: { userId: 'U_OPUS_47', defaultModel: 'claude-opus-4-7', accepted: true },
  U_OPUS_48_1M: { userId: 'U_OPUS_48_1M', defaultModel: 'claude-opus-4-8[1m]', accepted: true },
  U_OPUS_5: { userId: 'U_OPUS_5', defaultModel: 'claude-opus-5', accepted: true },
  U_OPUS_5_1M: { userId: 'U_OPUS_5_1M', defaultModel: 'claude-opus-5[1m]', accepted: true },
  U_SONNET: { userId: 'U_SONNET', defaultModel: 'claude-sonnet-4-6', accepted: true },
  U_SOL: { userId: 'U_SOL', defaultModel: 'gpt-5.6-sol', accepted: true },
  U_FABLE: { userId: 'U_FABLE', defaultModel: 'claude-fable-5[1m]', accepted: true },
};

const OPUS_ROWS = ['U_OPUS_45', 'U_OPUS_46', 'U_OPUS_46_1M', 'U_OPUS_47', 'U_OPUS_48_1M', 'U_OPUS_5', 'U_OPUS_5_1M'];
const CONTROL_ROWS = ['U_SONNET', 'U_SOL', 'U_FABLE'];

describe('forceMigrateOpus1m — target and marker name', () => {
  it('targets claude-opus-5[1m] and shares the store transform target', () => {
    expect(OPUS_MIGRATION_TARGET).toBe('claude-opus-5[1m]');
    // Drift guard: the deploy module declares the literal (it must stay
    // import-lean) but it may never disagree with the store's constant.
    expect(OPUS_MIGRATION_TARGET).toBe(OPUS_DEFAULT_MIGRATION_TARGET);
  });

  it('uses a dedicated marker file separate from .main-bootstrap.json', () => {
    expect(OPUS_1M_MIGRATION_MARKER).toBe('.opus-1m-migration.json');
  });
});

describe('forceMigrateOpus1m — first run is Opus-family selective', () => {
  it('rewrites only opus-family rows and counts only the ones it changed', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, MIXED_POPULATION);

    const result = forceMigrateOpus1m({ dataDir });

    expect(result.status).toBe('applied');
    // 7 opus rows, but `U_OPUS_5_1M` is already on target → 6 changed.
    expect(result.migrated).toBe(6);
    expect(result.total).toBe(10);

    const after = readSettings(dataDir);
    for (const u of OPUS_ROWS) {
      expect(after[u]?.defaultModel).toBe('claude-opus-5[1m]');
    }
  });

  it('leaves every non-opus row byte-identical (the retired all-user bug)', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, MIXED_POPULATION);

    forceMigrateOpus1m({ dataDir });

    const after = readSettings(dataDir);
    for (const u of CONTROL_ROWS) {
      expect(after[u]).toEqual(MIXED_POPULATION[u]);
    }
  });

  it('writes the marker with the new target + counts + timestamp', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, { U1: { userId: 'U1', defaultModel: 'claude-opus-4-7' } });

    const now = new Date('2026-08-26T03:00:00.000Z');
    const result = forceMigrateOpus1m({ dataDir, now: () => now });
    expect(result.status).toBe('applied');

    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, OPUS_1M_MIGRATION_MARKER), 'utf8'));
    expect(marker.target).toBe('claude-opus-5[1m]');
    expect(marker.migrated).toBe(1);
    expect(marker.total).toBe(1);
    expect(marker.migratedAt).toBe('2026-08-26T03:00:00.000Z');
  });

  it('preserves non-defaultModel fields on a migrated entry', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, {
      U1: {
        userId: 'U1',
        defaultModel: 'claude-opus-4-7',
        persona: 'engineer',
        accepted: true,
        defaultDirectory: '/repos/foo',
        defaultEffort: 'xhigh',
      },
    });

    forceMigrateOpus1m({ dataDir });
    expect(readSettings(dataDir).U1).toEqual({
      userId: 'U1',
      defaultModel: 'claude-opus-5[1m]',
      persona: 'engineer',
      accepted: true,
      defaultDirectory: '/repos/foo',
      defaultEffort: 'xhigh',
    });
  });

  it('never touches sessions.json', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, MIXED_POPULATION);
    const sessionsFile = path.join(dataDir, 'sessions.json');
    const sentinel = JSON.stringify({ 'C1:171.1': { model: 'claude-opus-4-7[1m]' } }, null, 2);
    fs.writeFileSync(sessionsFile, sentinel, 'utf8');

    forceMigrateOpus1m({ dataDir });

    expect(fs.readFileSync(sessionsFile, 'utf8')).toBe(sentinel);
  });

  it('skips the settings write when no opus row needs migrating, but still marks', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, {
      U1: { userId: 'U1', defaultModel: 'gpt-5.6-sol' },
      U2: { userId: 'U2', defaultModel: 'claude-opus-5[1m]' },
    });
    const file = path.join(dataDir, 'user-settings.json');
    const before = fs.readFileSync(file, 'utf8');

    const result = forceMigrateOpus1m({ dataDir });

    expect(result.migrated).toBe(0);
    expect(result.total).toBe(2);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dataDir, OPUS_1M_MIGRATION_MARKER))).toBe(true);
  });

  it('skips file write when user-settings.json is absent but still writes the marker', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const result = forceMigrateOpus1m({ dataDir });
    expect(result.status).toBe('applied');
    expect(result.migrated).toBe(0);
    expect(result.total).toBe(0);
    expect(fs.existsSync(path.join(dataDir, OPUS_1M_MIGRATION_MARKER))).toBe(true);
  });
});

describe('forceMigrateOpus1m — target-aware, idempotent re-runs', () => {
  it('short-circuits when the marker already records the current target', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, { U1: { userId: 'U1', defaultModel: 'claude-opus-4-7' } });
    expect(forceMigrateOpus1m({ dataDir }).status).toBe('applied');

    // Tamper AFTER the marker is in place — the re-run must not read settings.
    writeSettings(dataDir, { U1: { userId: 'U1', defaultModel: 'claude-opus-4-7' } });
    const second = forceMigrateOpus1m({ dataDir });
    expect(second.status).toBe('skipped');
    expect(readSettings(dataDir).U1?.defaultModel).toBe('claude-opus-4-7');
  });

  it('treats the RETIRED gpt-5.6-sol marker as an older target: reruns once, then skips', () => {
    // This is the live-host path. Every deployed host carries a marker whose
    // target is `gpt-5.6-sol`, so the boot after this change must migrate the
    // opus rows exactly once — and must NOT drag the gpt/sonnet rows anywhere.
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, MIXED_POPULATION);
    writeMarker(dataDir, RETIRED_ALL_USER_TARGET);

    const rerun = forceMigrateOpus1m({ dataDir });
    expect(rerun.status).toBe('applied');
    const after = readSettings(dataDir);
    for (const u of OPUS_ROWS) {
      expect(after[u]?.defaultModel).toBe('claude-opus-5[1m]');
    }
    for (const u of CONTROL_ROWS) {
      expect(after[u]).toEqual(MIXED_POPULATION[u]);
    }

    expect(forceMigrateOpus1m({ dataDir }).status).toBe('skipped');
  });

  it('treats the 2026-06 opus[1m] marker as an older target too', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, { U1: { userId: 'U1', defaultModel: 'claude-opus-4-8[1m]' } });
    writeMarker(dataDir, HISTORICAL_OPUS_1M_TARGET);

    expect(forceMigrateOpus1m({ dataDir }).status).toBe('applied');
    expect(readSettings(dataDir).U1?.defaultModel).toBe('claude-opus-5[1m]');
    expect(forceMigrateOpus1m({ dataDir }).status).toBe('skipped');
  });

  it('re-runs when the marker is corrupt (unreadable JSON)', () => {
    const dataDir = path.join(makeTempDir(), 'data');
    writeSettings(dataDir, {
      U1: { userId: 'U1', defaultModel: 'claude-opus-4-7' },
      U2: { userId: 'U2', defaultModel: 'claude-sonnet-4-6' },
    });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, OPUS_1M_MIGRATION_MARKER), '{not json', 'utf8');

    const result = forceMigrateOpus1m({ dataDir });
    expect(result.status).toBe('applied');
    expect(readSettings(dataDir).U1?.defaultModel).toBe('claude-opus-5[1m]');
    // A corrupt marker used to mean "rewrite EVERY user" — now the blast
    // radius of that fail-open is bounded to the opus family.
    expect(readSettings(dataDir).U2?.defaultModel).toBe('claude-sonnet-4-6');
  });
});
