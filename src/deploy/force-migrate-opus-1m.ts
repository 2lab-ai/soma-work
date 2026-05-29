/**
 * One-shot force-migration of every persisted `defaultModel` in
 * `user-settings.json` to the current `opus[1m]` target.
 *
 * Why this exists. Bumping the in-code `DEFAULT_MODEL` only affects users
 * whose stored `defaultModel` is missing or coerced-away. Existing users on
 * other valid models (e.g. `claude-opus-4-7`, `claude-opus-4-7[1m]`,
 * `claude-sonnet-4-6`) would stay on those models indefinitely. The user
 * instruction was explicit: every user should land on `opus[1m]` once,
 * with the option to opt back manually via the `/model` command afterward.
 *
 * Why not piggyback on `normalizeMainTargetData`. `normalizeMainTargetData`
 * is `coerceModel` — it preserves valid stored values and only nudges
 * unknown/missing ones to DEFAULT_MODEL. That's the right behaviour for the
 * deploy-time bootstrap (which itself is gated by `.main-bootstrap.json`),
 * but it does NOT touch an in-place deployment. This module is the missing
 * leg: a runtime, idempotent, one-shot rewrite gated by a dedicated marker.
 *
 * Why a separate marker. The deploy bootstrap marker
 * (`.main-bootstrap.json`) lives in the target dir. The data dir lives in
 * a separate, persistent location. Re-using the deploy marker would either
 * pin migration to fresh installs only or require coupling unrelated
 * lifecycles. The dedicated `.opus-1m-migration.json` marker also makes a
 * future-PR "bump the migration target to opus-4-9[1m]" trivial:
 * delete-and-rerun, or invert the predicate to compare against the marker's
 * `target` field.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ModelId } from '../user-settings-store';

/** Target model id every user lands on after this migration runs. */
export const OPUS_1M_TARGET: ModelId = 'claude-opus-4-8[1m]';

/** Dedicated marker file name (sibling of user-settings.json in DATA_DIR). */
export const OPUS_1M_MIGRATION_MARKER = '.opus-1m-migration.json';

export interface ForceMigrateOpus1mParams {
  /**
   * Directory holding `user-settings.json` and where the marker file is
   * written. Caller-supplied so the migration is testable without env vars.
   */
  dataDir: string;
  /**
   * Override the marker target. Defaults to {@link OPUS_1M_TARGET}; kept as
   * a parameter so a future re-run with a different target can be wired
   * without changing this module's surface.
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
  const target = params.target ?? OPUS_1M_TARGET;
  const now = params.now ?? (() => new Date());
  const settingsFile = path.join(params.dataDir, 'user-settings.json');
  const markerFile = path.join(params.dataDir, OPUS_1M_MIGRATION_MARKER);

  // Marker presence is the sole short-circuit signal. Even if the data
  // dir was tampered with after the previous run, we do not re-touch.
  if (fs.existsSync(markerFile)) {
    return { status: 'skipped', markerFile, migrated: 0, total: 0 };
  }

  let migrated = 0;
  let total = 0;

  if (fs.existsSync(settingsFile)) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, Record<string, unknown>>;

    for (const userSettings of Object.values(settings)) {
      total += 1;
      if (userSettings.defaultModel !== target) {
        userSettings.defaultModel = target;
        migrated += 1;
      }
    }

    if (migrated > 0) {
      fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
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
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

  return { status: 'applied', markerFile, migrated, total };
}
