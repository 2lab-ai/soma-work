/**
 * One-shot migration of persisted `defaultModel` values in
 * `user-settings.json`. This is the SINGLE authority for rewriting a user
 * default — `UserSettingsStore.loadSettings` deliberately does not repeat it,
 * because a second, every-boot rewrite would overrule a user who deliberately
 * picked an older generation after the one-shot had already run.
 *
 * 2026-08-26 — the ALL-USER rewrite is retired. Until now this module forced
 * every user onto one target (`gpt-5.6-sol` since 2026-07-10, `opus[1m]`
 * before). That is not what the current instruction asks for and it is
 * actively destructive: on any host whose marker is missing, corrupt, or
 * written for an older target, it silently discarded every user's own model
 * choice. What remains is the narrow migration that was actually requested:
 *
 *   - opus-family defaults (`claude-opus-*`, bare or `[1m]`, including a bare
 *     `claude-opus-5`) converge on `claude-opus-5[1m]`;
 *   - every other user is left byte-identical;
 *   - `sessions.json` is never opened — active sessions keep their model.
 *
 * The transform is not re-implemented here: it is
 * `user-settings-store.migrateOpusDefaultModel`, so the two places that know
 * "what is an opus default worth migrating" cannot drift.
 *
 * Why this exists at all. Bumping the in-code `DEFAULT_MODEL` only affects
 * users whose stored `defaultModel` is missing or coerced-away, and
 * `normalizeMainTargetData` (the deploy bootstrap) is `coerceModel` — it
 * preserves valid stored values and never runs on an in-place deployment.
 * This module is the missing leg: a runtime, idempotent, one-shot rewrite
 * gated by a dedicated marker.
 *
 * Why a separate marker. The deploy bootstrap marker (`.main-bootstrap.json`)
 * lives in the target dir; the data dir is a separate, persistent location.
 * The dedicated `.opus-1m-migration.json` marker is TARGET-AWARE, which is
 * what makes this retirement safe on a live host: the deployed marker records
 * the old `gpt-5.6-sol` target, so the first boot after this change re-runs
 * once for the new selective target and then skips forever.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '@soma/common/atomic-write';

import { type ModelId, migrateOpusDefaultModel, OPUS_DEFAULT_MIGRATION_TARGET } from '../user-settings-store';

/**
 * Target opus-family defaults land on, and the value recorded in the marker.
 *
 * Re-exported from the store rather than re-declared: the transform below is
 * `migrateOpusDefaultModel`, so a second literal here could only ever be a way
 * for the marker to disagree with what was actually written.
 */
export const OPUS_MIGRATION_TARGET: ModelId = OPUS_DEFAULT_MIGRATION_TARGET;

/** Dedicated marker file name (sibling of user-settings.json in DATA_DIR). */
export const OPUS_1M_MIGRATION_MARKER = '.opus-1m-migration.json';

export interface ForceMigrateOpus1mParams {
  /**
   * Directory holding `user-settings.json` and where the marker file is
   * written. Caller-supplied so the migration is testable without env vars.
   */
  dataDir: string;
  /**
   * Override the marker target. Defaults to {@link OPUS_MIGRATION_TARGET};
   * kept as a parameter so a future re-run with a different target can be
   * wired without changing this module's surface.
   */
  target?: ModelId;
  /** Injected clock for deterministic marker timestamps in tests. */
  now?: () => Date;
}

export interface ForceMigrateOpus1mResult {
  /** `skipped` if the marker already exists; `applied` on first-run. */
  status: 'skipped' | 'applied';
  /** Absolute path to the marker file (whether or not it was just written). */
  markerFile: string;
  /** Number of user entries whose `defaultModel` was changed by this run. */
  migrated: number;
  /** Total number of user entries inspected. */
  total: number;
}

interface OpusOneMMarker {
  migratedAt: string;
  target: ModelId;
  migrated: number;
  total: number;
}

export function forceMigrateOpus1m(params: ForceMigrateOpus1mParams): ForceMigrateOpus1mResult {
  const target = params.target ?? OPUS_MIGRATION_TARGET;
  const now = params.now ?? (() => new Date());
  const settingsFile = path.join(params.dataDir, 'user-settings.json');
  const markerFile = path.join(params.dataDir, OPUS_1M_MIGRATION_MARKER);

  // Target-aware short-circuit: skip only when the existing marker already
  // records THIS target. A marker for an older target — the retired
  // `gpt-5.6-sol` all-user run, or the 2026-06 `opus[1m]` one — re-runs
  // exactly once and is then overwritten with the new target. An unreadable
  // marker re-runs too: the migration is a convergent, opus-only rewrite, so
  // a spurious re-run is bounded and harmless, while a wrongly-skipped one
  // strands users on a dead generation.
  if (fs.existsSync(markerFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as Partial<OpusOneMMarker>;
      if (existing.target === target) {
        return { status: 'skipped', markerFile, migrated: 0, total: 0 };
      }
    } catch {
      // fall through — corrupt marker, re-run and rewrite it.
    }
  }

  let migrated = 0;
  let total = 0;

  if (fs.existsSync(settingsFile)) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, Record<string, unknown>>;

    for (const userSettings of Object.values(settings)) {
      total += 1;
      const current = userSettings.defaultModel;
      if (typeof current !== 'string') continue;
      // Selective: `migrateOpusDefaultModel` returns non-opus values
      // byte-identical, so this comparison is what keeps every other user out
      // of the rewrite entirely — including out of the `migrated` count.
      const next = migrateOpusDefaultModel(current);
      if (next !== current) {
        userSettings.defaultModel = next;
        migrated += 1;
      }
    }

    // Only when something actually changed: a no-op boot must leave the file
    // (and its bytes) alone. `atomicWriteJson` is the repo-wide contract for
    // JSON state — tmp file + fsync + rename, so a crash mid-write cannot
    // truncate every user's settings. It sorts keys, so the FIRST migrating
    // boot also normalises key order; subsequent loads round-trip that order
    // unchanged, so it is a one-time diff, not per-boot churn.
    if (migrated > 0) {
      atomicWriteJson(settingsFile, settings, { backup: true });
    }
  }

  // Ensure the data dir itself exists before writing the marker — a fresh
  // install may not have created it yet.
  fs.mkdirSync(params.dataDir, { recursive: true });

  const marker: OpusOneMMarker = {
    migratedAt: now().toISOString(),
    target,
    migrated,
    total,
  };
  atomicWriteJson(markerFile, marker);

  return { status: 'applied', markerFile, migrated, total };
}
