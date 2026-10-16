/**
 * 2026-10-16 one-time ALL-USER Slack verbosity rewrite to `minimal` (spec 10
 * §3.2-1).
 *
 * Operator instruction: every user's Slack work-message output moves to the
 * `minimal` default ONCE — the model's running narration goes to the dashboard
 * work log instead of the thread. Same contract as
 * `migrate-all-users-opus-once.ts`: this touches EVERY user, so it must never
 * run twice, and a user who picks another level afterwards keeps that choice
 * forever. The marker is therefore PRESENCE-only: if the file exists —
 * readable, corrupt, empty, anything — the migration is done.
 *
 * Scope — both places a verbosity lives:
 *   - `user-settings.json`: every user's `defaultLogVerbosity` → `'minimal'`
 *     (users without one get it too, "every user");
 *   - `sessions.json`: every persisted session's `logVerbosity` mask →
 *     `LOG_MINIMAL`. A session copies its mask at creation, so rewriting only
 *     the defaults would leave every live thread on its old level; a missing
 *     mask is written too, because consumers read it as `?? LOG_DETAIL`.
 * The sessions file is read back by `SessionRegistry.loadSessions()` later in
 * boot (src/index.ts), so this must run before that restore.
 *
 * Ordering — MARKER FIRST:
 *   1. read + shape-validate both files; an unreadable or mis-shaped file
 *      throws here, before anything is written, so the next boot retries;
 *   2. write the marker (counts computed from the pre-read);
 *   3. only then write the data.
 * A failure in step 3 means the one-shot is missed (the caller logs it at
 * error level): users and threads stay on their previous levels. Those stored
 * masks predate the NARRATION flag, so on their own they would now read as a
 * `custom` level with narration hidden — `SessionRegistry.loadSessions()`
 * maps them back to the current presets (`upgradeLegacyVerbosityMask`), which
 * is what keeps a missed one-shot from degrading those threads. The reverse
 * order could let a later boot replay the rewrite on top of choices users made
 * in between, which is the one outcome this module must never produce.
 *
 * Concurrency: no other process can run this (or write either file) at the
 * same time — the daemon calls it only while holding the exclusive pid lock,
 * `acquirePidLock(DATA_DIR)` (O_CREAT|O_EXCL, src/pid-lock.ts), taken at the
 * top of `start()` in src/index.ts before the migration and before
 * `loadSavedSessions()`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '@soma/common/atomic-write';
import { LOG_MINIMAL, type LogVerbosity } from '@soma/slack/output-flags';

/** Presence of this file (sibling of user-settings.json) = migration done. */
export const ALL_USERS_LOG_MINIMAL_ONCE_MARKER = '.all-users-log-minimal-once-2026-10-16.json';

/**
 * Pre-rewrite snapshots. `atomicWriteJson`'s `.bak` is a single rolling
 * generation that the next write overwrites, so the original per-user and
 * per-session levels are kept here for a manual revert.
 */
export const ALL_USERS_LOG_MINIMAL_ONCE_SETTINGS_SNAPSHOT = 'user-settings.pre-all-users-log-minimal-2026-10-16.json';
export const ALL_USERS_LOG_MINIMAL_ONCE_SESSIONS_SNAPSHOT = 'sessions.pre-all-users-log-minimal-2026-10-16.json';

const TARGET_LEVEL: LogVerbosity = 'minimal';

export interface MigrateAllUsersMinimalOnceParams {
  /** Directory holding `user-settings.json` and `sessions.json`; the marker is written here too. */
  dataDir: string;
  /** Injected clock for deterministic marker timestamps in tests. */
  now?: () => Date;
}

export interface MigrationCount {
  /** Entries this run changed (or set). */
  migrated: number;
  /** Entries inspected. */
  total: number;
}

export interface MigrateAllUsersMinimalOnceResult {
  /** `skipped` when the marker exists (in any state); `applied` otherwise. */
  status: 'skipped' | 'applied';
  users: MigrationCount;
  sessions: MigrationCount;
  markerFile: string;
}

/**
 * Marker payload — diagnostic only (the marker is presence-only, never parsed).
 * Written BEFORE the data, so the counts are the rewrites this run was about to
 * ATTEMPT, computed from the pre-read; they are not confirmed writes. A throw
 * in the data step leaves this marker in place with these counts.
 */
interface AllUsersMinimalOnceMarker {
  markedAt: string;
  mask: number;
  attemptedUsers: number;
  totalUsers: number;
  attemptedSessions: number;
  totalSessions: number;
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

/** Parse + shape-check the sessions file. Throws on anything but `[{…}, …]` (the `saveSessions` shape). */
function readSessions(sessionsFile: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`sessions.json root is not an array: ${sessionsFile}`);
  }
  parsed.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`sessions.json entry #${index} is not an object: ${sessionsFile}`);
    }
  });
  return parsed as Array<Record<string, unknown>>;
}

export function migrateAllUsersMinimalOnce(params: MigrateAllUsersMinimalOnceParams): MigrateAllUsersMinimalOnceResult {
  const now = params.now ?? (() => new Date());
  const settingsFile = path.join(params.dataDir, 'user-settings.json');
  const sessionsFile = path.join(params.dataDir, 'sessions.json');
  const markerFile = path.join(params.dataDir, ALL_USERS_LOG_MINIMAL_ONCE_MARKER);

  // Presence-only: never parse the marker. A corrupt marker still means "this
  // host already ran it" — re-running an all-user rewrite would overrule every
  // user who changed their level back afterwards.
  if (fs.existsSync(markerFile)) {
    return {
      status: 'skipped',
      users: { migrated: 0, total: 0 },
      sessions: { migrated: 0, total: 0 },
      markerFile,
    };
  }

  // 1. Read + validate BOTH files (throws before anything is written).
  const settings = fs.existsSync(settingsFile) ? readSettings(settingsFile) : null;
  const sessions = fs.existsSync(sessionsFile) ? readSessions(sessionsFile) : null;

  const users: MigrationCount = { migrated: 0, total: 0 };
  for (const userSettings of Object.values(settings ?? {})) {
    users.total += 1;
    if (userSettings.defaultLogVerbosity !== TARGET_LEVEL) {
      userSettings.defaultLogVerbosity = TARGET_LEVEL;
      users.migrated += 1;
    }
  }

  const sessionCount: MigrationCount = { migrated: 0, total: 0 };
  for (const session of sessions ?? []) {
    sessionCount.total += 1;
    if (session.logVerbosity !== LOG_MINIMAL) {
      session.logVerbosity = LOG_MINIMAL;
      sessionCount.migrated += 1;
    }
  }

  // 2. Marker FIRST — from here on this host never replays the rewrite.
  fs.mkdirSync(params.dataDir, { recursive: true });
  const marker: AllUsersMinimalOnceMarker = {
    markedAt: now().toISOString(),
    mask: LOG_MINIMAL,
    attemptedUsers: users.migrated,
    totalUsers: users.total,
    attemptedSessions: sessionCount.migrated,
    totalSessions: sessionCount.total,
  };
  atomicWriteJson(markerFile, marker);

  // 3. Data writes. A throw here propagates; the caller logs it at error level.
  if (settings && users.migrated > 0) {
    fs.copyFileSync(settingsFile, path.join(params.dataDir, ALL_USERS_LOG_MINIMAL_ONCE_SETTINGS_SNAPSHOT));
    atomicWriteJson(settingsFile, settings, { backup: true });
  }
  if (sessions && sessionCount.migrated > 0) {
    fs.copyFileSync(sessionsFile, path.join(params.dataDir, ALL_USERS_LOG_MINIMAL_ONCE_SESSIONS_SNAPSHOT));
    atomicWriteJson(sessionsFile, sessions, { backup: true });
  }

  return { status: 'applied', users, sessions: sessionCount, markerFile };
}
