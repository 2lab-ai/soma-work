/**
 * 2026-11-19 one-time rewrite: users on the OLD default move to opus.
 *
 * Owner instruction ("디폴트 = opus로 해줘", given in answer to "changing the
 * gpt default changes every user's default model"): when DEFAULT_MODEL moved
 * from the `gpt` alias (`gpt-5.6-sol`) to `MODEL_ALIASES.opus`, the users who
 * were sitting on the old default move too — not only brand-new users. The
 * store writes DEFAULT_MODEL into every record it creates (loadSettings
 * coercion, patchUserSettings, ensureUserExists, createPendingUser), so every
 * user created after the 2026-09-28 all-user opus rewrite has `gpt-5.6-sol`
 * saved whether they picked it or not.
 *
 * Scope — `user-settings.json` defaults only:
 *   - a saved `defaultModel` that is the previous default `gpt-5.6-sol`, or
 *     the retired `gpt-5.5` (`gpt5.5`, `[1m]`), in any spelling the store's
 *     coercion folds (trim + lowercase) → `MODEL_ALIASES.opus`;
 *   - every other saved value is kept byte-for-byte (`gpt-5.6-sol[1m]` is a
 *     different, deliberately chosen model and is kept too);
 *   - an entry with no `defaultModel` is left alone — it already reads the
 *     in-code DEFAULT_MODEL, which is opus;
 *   - `sessions.json` is never opened: a running session keeps its model.
 *
 * Same "exactly once, ever" contract as `migrate-all-users-opus-once.ts`: a
 * user who switches back to `gpt-5.6-sol` afterwards must keep that choice
 * forever, so the marker is PRESENCE-only — if the file exists (readable,
 * corrupt, empty, anything) the migration is done.
 *
 * Ordering — MARKER FIRST:
 *   1. read + shape-validate `user-settings.json`; an unreadable or mis-shaped
 *      file throws here, before anything is written, so the next boot retries;
 *   2. write the marker (counts computed from the pre-read);
 *   3. only then write the settings, after copying the original to the
 *      pre-rewrite snapshot (kept for a manual revert).
 * A failure in step 3 means the one-shot is missed (the caller logs it loudly)
 * — non-destructive. The reverse order could let a later boot replay the
 * rewrite on top of choices users made in between.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '@soma/common/atomic-write';

import { MODEL_ALIASES, type ModelId } from '../user-settings-store';

/** Presence of this file (sibling of user-settings.json) = migration done. */
export const DEFAULT_GPT_TO_OPUS_ONCE_MARKER = '.default-gpt-to-opus-once-2026-11-19.json';

/**
 * Pre-rewrite snapshot of `user-settings.json`. `atomicWriteJson`'s `.bak` is a
 * single rolling generation that the next settings write overwrites, so the
 * original per-user choices are kept here for a manual revert.
 */
export const DEFAULT_GPT_TO_OPUS_ONCE_SNAPSHOT = 'user-settings.pre-default-gpt-to-opus-2026-11-19.json';

/** The default model before 2026-11-19 (the `gpt` alias target). */
const PREVIOUS_DEFAULT = 'gpt-5.6-sol';

/** The retired gpt-5.5 spellings (model-profile.ts RETIRED_MODEL_INPUTS), `[1m]` stripped. */
const RETIRED_GPT_5_5 = new Set(['gpt-5.5', 'gpt5.5']);

/** True when a saved `defaultModel` is the previous default or the retired gpt-5.5. */
function isPreviousDefaultModel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === PREVIOUS_DEFAULT) return true;
  return RETIRED_GPT_5_5.has(normalized.replace(/\[1m\]$/, ''));
}

export interface MigrateDefaultGptToOpusOnceParams {
  /** Directory holding `user-settings.json`; the marker is written here too. */
  dataDir: string;
  /** Injected clock for deterministic marker timestamps in tests. */
  now?: () => Date;
}

export interface MigrateDefaultGptToOpusOnceResult {
  /** `skipped` when the marker exists (in any state); `applied` otherwise. */
  status: 'skipped' | 'applied';
  markerFile: string;
  /** User entries whose `defaultModel` was rewritten by this run. */
  migrated: number;
  /** User entries inspected. */
  total: number;
  /** The id written — resolved from `MODEL_ALIASES.opus` at run time. */
  target: ModelId;
}

interface DefaultGptToOpusOnceMarker {
  migratedAt: string;
  target: ModelId;
  migrated: number;
  total: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse + shape-check the settings file. Throws on anything but `{ [user]: {…} }`. */
function readSettings(settingsFile: string): Record<string, Record<string, unknown>> {
  const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (!isPlainObject(parsed)) {
    throw new Error(`user-settings.json root is not an object: ${settingsFile}`);
  }
  for (const [userId, entry] of Object.entries(parsed)) {
    if (!isPlainObject(entry)) {
      throw new Error(`user-settings.json entry '${userId}' is not an object: ${settingsFile}`);
    }
  }
  return parsed as Record<string, Record<string, unknown>>;
}

export function migrateDefaultGptToOpusOnce(
  params: MigrateDefaultGptToOpusOnceParams,
): MigrateDefaultGptToOpusOnceResult {
  const target = MODEL_ALIASES.opus;
  const now = params.now ?? (() => new Date());
  const settingsFile = path.join(params.dataDir, 'user-settings.json');
  const markerFile = path.join(params.dataDir, DEFAULT_GPT_TO_OPUS_ONCE_MARKER);

  // Presence-only: never parse the marker. A corrupt marker still means "this
  // host already ran it" — re-running would overrule every user who switched
  // back to gpt-5.6-sol afterwards.
  if (fs.existsSync(markerFile)) {
    return { status: 'skipped', markerFile, migrated: 0, total: 0, target };
  }

  // 1. Read + validate (throws before anything is written).
  const settings = fs.existsSync(settingsFile) ? readSettings(settingsFile) : null;

  let migrated = 0;
  let total = 0;
  if (settings) {
    for (const userSettings of Object.values(settings)) {
      total += 1;
      if (isPreviousDefaultModel(userSettings.defaultModel)) {
        userSettings.defaultModel = target;
        migrated += 1;
      }
    }
  }

  // 2. Marker FIRST — from here on this host never replays the rewrite.
  fs.mkdirSync(params.dataDir, { recursive: true });
  const marker: DefaultGptToOpusOnceMarker = { migratedAt: now().toISOString(), target, migrated, total };
  atomicWriteJson(markerFile, marker);

  // 3. Data write. A throw here propagates; the caller logs it at error level.
  if (settings && migrated > 0) {
    fs.copyFileSync(settingsFile, path.join(params.dataDir, DEFAULT_GPT_TO_OPUS_ONCE_SNAPSHOT));
    atomicWriteJson(settingsFile, settings, { backup: true });
  }

  return { status: 'applied', markerFile, migrated, total, target };
}
