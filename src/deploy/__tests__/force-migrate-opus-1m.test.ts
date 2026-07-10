/**
 * One-shot force-migration of every persisted `defaultModel` to the current
 * default target (gpt-5.6 since 2026-07-10; opus[1m] before). Originally
 * triggered by user instruction:
 *
 *   "soma-work에는 디폴트 모델을 opus[1m]으로 변경하라는건 모든 유저의 모델이
 *    opus[1m]이 아닌 경우 1회 opus[1m]으로 마이그레이션하라는 것"
 *
 * 2026-07-10 update: the marker short-circuit is TARGET-AWARE (the doc's
 * "flip the predicate" option) — a marker for an older target re-runs once
 * for the new target, then skips.
 *
 * Contract:
 *   - On first run (marker absent): every user-settings.json entry whose
 *     `defaultModel` is not already the target is overwritten to the target.
 *     Existing entries that already equal the target are left untouched
 *     (idempotent count).
 *   - Marker file `.opus-1m-migration.json` is written into the data dir
 *     containing { migratedAt, target, migrated, total }. The marker's
 *     presence is the SOLE signal that this migration has run — re-runs MUST
 *     short-circuit without reading user-settings.json.
 *   - The marker carries the *target* model id so a future rerun against a
 *     bumped target (e.g. `claude-opus-4-9[1m]`) can be wired by deleting
 *     the previous marker (or by flipping the predicate to "if marker's
 *     target != current target"). That's a future-PR decision; this PR
 *     fixes the marker semantics to one-shot.
 *   - The function never throws on missing files (empty data dir → no-op +
 *     marker written, so a fresh-install host doesn't re-attempt on every
 *     boot).
 *   - 4.7 / 4.6 / other historical entries are NOT preserved — the user's
 *     intent is "everyone moves to opus[1m]". Users who want to opt back to
 *     4.7 do it explicitly via the `/model` Slack command after migration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORCE_DEFAULT_TARGET,
  forceMigrateOpus1m,
  OPUS_1M_MIGRATION_MARKER,
  OPUS_1M_TARGET,
} from '../force-migrate-opus-1m';

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

describe('forceMigrateOpus1m — target and marker name', () => {
  it('default target is gpt-5.6 (2026-07-10); the historical opus[1m] constant survives', () => {
    expect(FORCE_DEFAULT_TARGET).toBe('gpt-5.6');
    expect(OPUS_1M_TARGET).toBe('claude-opus-4-8[1m]');
  });

  it('uses a dedicated marker file separate from .main-bootstrap.json', () => {
    expect(OPUS_1M_MIGRATION_MARKER).toBe('.opus-1m-migration.json');
  });
});

describe('forceMigrateOpus1m — first run', () => {
  it('overwrites every user.defaultModel that is not already the target', () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data');
    writeSettings(dataDir, {
      U1: { userId: 'U1', defaultModel: 'claude-opus-4-7', accepted: true },
      U2: { userId: 'U2', defaultModel: 'claude-opus-4-7[1m]', accepted: true },
      U3: { userId: 'U3', defaultModel: 'claude-sonnet-4-6', accepted: true },
      U4: { userId: 'U4', defaultModel: 'gpt-5.6', accepted: true },
      U5: { userId: 'U5', defaultModel: 'claude-haiku-4-5-20251001', accepted: true },
    });

    const result = forceMigrateOpus1m({ dataDir });

    expect(result.status).toBe('applied');
    expect(result.migrated).toBe(4); // U4 was already on target
    expect(result.total).toBe(5);

    const after = readSettings(dataDir);
    for (const u of ['U1', 'U2', 'U3', 'U4', 'U5']) {
      expect(after[u]?.defaultModel).toBe('gpt-5.6');
    }
  });

  it('writes the marker file with target + counts + timestamp', () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data');
    writeSettings(dataDir, {
      U1: { userId: 'U1', defaultModel: 'claude-opus-4-7' },
    });

    const now = new Date('2026-05-29T03:00:00.000Z');
    const result = forceMigrateOpus1m({ dataDir, now: () => now });
    expect(result.status).toBe('applied');

    const markerPath = path.join(dataDir, '.opus-1m-migration.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(marker.target).toBe('gpt-5.6');
    expect(marker.migrated).toBe(1);
    expect(marker.total).toBe(1);
    expect(marker.migratedAt).toBe('2026-05-29T03:00:00.000Z');
  });

  it('preserves non-defaultModel fields on each user entry', () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data');
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
    const after = readSettings(dataDir);
    expect(after.U1).toMatchObject({
      userId: 'U1',
      defaultModel: 'gpt-5.6',
      persona: 'engineer',
      accepted: true,
      defaultDirectory: '/repos/foo',
      defaultEffort: 'xhigh',
    });
  });

  it('skips file write when user-settings.json is absent (empty install) but still writes the marker', () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const result = forceMigrateOpus1m({ dataDir });
    expect(result.status).toBe('applied');
    expect(result.migrated).toBe(0);
    expect(result.total).toBe(0);
    expect(fs.existsSync(path.join(dataDir, '.opus-1m-migration.json'))).toBe(true);
  });
});

describe('forceMigrateOpus1m — idempotent re-runs', () => {
  it('short-circuits when the marker already records the current target', () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data');
    writeSettings(dataDir, {
      U1: { userId: 'U1', defaultModel: 'claude-opus-4-7' },
    });
    // First run: applies.
    const first = forceMigrateOpus1m({ dataDir });
    expect(first.status).toBe('applied');

    // Tamper user-settings.json AFTER the marker is in place — re-run must
    // leave it alone (this is the regression-guard for "ran twice on the
    // same host" behaviour).
    writeSettings(dataDir, {
      U1: { userId: 'U1', defaultModel: 'claude-opus-4-7' },
    });
    const second = forceMigrateOpus1m({ dataDir });
    expect(second.status).toBe('skipped');
    expect(readSettings(dataDir).U1?.defaultModel).toBe('claude-opus-4-7');
  });

  it('re-runs exactly once when the marker records an OLDER target (opus[1m] → gpt-5.6)', () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data');
    writeSettings(dataDir, {
      U1: { userId: 'U1', defaultModel: 'claude-opus-4-8[1m]' },
    });
    // Simulate a host that already ran the 2026-06 opus[1m] migration.
    fs.writeFileSync(
      path.join(dataDir, OPUS_1M_MIGRATION_MARKER),
      JSON.stringify({ migratedAt: '2026-06-01T00:00:00.000Z', target: OPUS_1M_TARGET, migrated: 3, total: 3 }),
      'utf8',
    );

    const rerun = forceMigrateOpus1m({ dataDir });
    expect(rerun.status).toBe('applied');
    expect(readSettings(dataDir).U1?.defaultModel).toBe('gpt-5.6');

    // Marker now records the new target — third run skips.
    const third = forceMigrateOpus1m({ dataDir });
    expect(third.status).toBe('skipped');
  });

  it('re-runs when the marker is corrupt (unreadable JSON)', () => {
    const dir = makeTempDir();
    const dataDir = path.join(dir, 'data');
    writeSettings(dataDir, {
      U1: { userId: 'U1', defaultModel: 'claude-opus-4-7' },
    });
    fs.writeFileSync(path.join(dataDir, OPUS_1M_MIGRATION_MARKER), '{not json', 'utf8');

    const result = forceMigrateOpus1m({ dataDir });
    expect(result.status).toBe('applied');
    expect(readSettings(dataDir).U1?.defaultModel).toBe('gpt-5.6');
  });
});
