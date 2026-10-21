/**
 * 2026-09-28 one-time ALL-USER default-model rewrite to the latest opus.
 *
 * Operator instruction: every user's default model moves to `opus` ONCE
 * (`MODEL_ALIASES.opus` → `claude-opus-5-5[1m]`, the same id llmux maps its
 * `opus` alias to). This is deliberately a different animal from
 * `force-migrate-opus-1m.ts`:
 *
 *   - that module is opus-family-only and TARGET-AWARE — it re-runs whenever
 *     the opus target moves, which is safe because it only ever touches users
 *     who already chose opus;
 *   - this module touches EVERY user, so it must never run twice. A user who
 *     switches back to their old model after this rewrite must keep that
 *     choice forever. The marker is therefore PRESENCE-only: if the file
 *     exists — readable, corrupt, empty, anything — the migration is done.
 *
 * Scope: `user-settings.json` defaults only. `sessions.json` is never opened —
 * a running session keeps the model it has. Users whose entry has no
 * `defaultModel` at all get one too ("every user"), since otherwise they would
 * keep resolving to the in-code DEFAULT_MODEL. DEFAULT_MODEL itself is NOT
 * changed: brand-new users after this boot still get the gpt flagship.
 *
 * Ordering — MARKER FIRST:
 *   1. read + shape-validate `user-settings.json`; an unreadable or mis-shaped
 *      file throws here, before anything is written, so the next boot retries;
 *   2. write the marker (counts computed from the pre-read);
 *   3. only then write the settings.
 * A failure in step 3 means the one-shot is missed (the caller logs it loudly)
 * — non-destructive. The reverse order could let a later boot replay the
 * rewrite on top of choices users made in between, which is the one outcome
 * this module must never produce.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '@soma/common/atomic-write';

import { MODEL_ALIASES, type ModelId } from '../user-settings-store';

/** Presence of this file (sibling of user-settings.json) = migration done. */
export const ALL_USERS_OPUS_ONCE_MARKER = '.all-users-opus-once-2026-09-28.json';

/**
 * Pre-rewrite snapshot of `user-settings.json`. `atomicWriteJson`'s `.bak` is a
 * single rolling generation that the next settings write overwrites, so the
 * original per-user choices are kept here for a manual revert.
 */
export const ALL_USERS_OPUS_ONCE_SNAPSHOT = 'user-settings.pre-all-users-opus-2026-09-28.json';

export interface MigrateAllUsersOpusOnceParams {
  /** Directory holding `user-settings.json`; the marker is written here too. */
  dataDir: string;
  /** Injected clock for deterministic marker timestamps in tests. */
  now?: () => Date;
}

export interface MigrateAllUsersOpusOnceResult {
  /** `skipped` when the marker exists (in any state); `applied` otherwise. */
  status: 'skipped' | 'applied';
  markerFile: string;
  /** User entries whose `defaultModel` was changed (or set) by this run. */
  migrated: number;
  /** User entries inspected. */
  total: number;
  /** The id written — resolved from `MODEL_ALIASES.opus` at run time. */
  target: ModelId;
}

interface AllUsersOpusOnceMarker {
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

export function migrateAllUsersOpusOnce(params: MigrateAllUsersOpusOnceParams): MigrateAllUsersOpusOnceResult {
  const target = MODEL_ALIASES.opus;
  const now = params.now ?? (() => new Date());
  const settingsFile = path.join(params.dataDir, 'user-settings.json');
  const markerFile = path.join(params.dataDir, ALL_USERS_OPUS_ONCE_MARKER);

  // Presence-only: never parse the marker. A corrupt marker still means "this
  // host already ran it" — re-running an all-user rewrite would overrule every
  // user who changed their model back afterwards.
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
      if (userSettings.defaultModel !== target) {
        userSettings.defaultModel = target;
        migrated += 1;
      }
    }
  }

  // 2. Marker FIRST — from here on this host never replays the rewrite.
  fs.mkdirSync(params.dataDir, { recursive: true });
  const marker: AllUsersOpusOnceMarker = { migratedAt: now().toISOString(), target, migrated, total };
  atomicWriteJson(markerFile, marker);

  // 3. Data write. A throw here propagates; the caller logs it at error level.
  if (settings && migrated > 0) {
    fs.copyFileSync(settingsFile, path.join(params.dataDir, ALL_USERS_OPUS_ONCE_SNAPSHOT));
    atomicWriteJson(settingsFile, settings, { backup: true });
  }

  return { status: 'applied', markerFile, migrated, total, target };
}
