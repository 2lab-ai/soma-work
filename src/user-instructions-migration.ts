/**
 * User Instructions Migration — eager startup + admin-script entry.
 *
 * Issue: #754 (parent epic #727)
 *
 * Reads the legacy `data/sessions.json` (per-session `instructions[]`) and
 * projects it onto the sealed user-scope master at
 * `data/users/{userId}/user-session.json`. Idempotent — running twice
 * produces the exact same on-disk state.
 *
 * Sealed current-pointer rule (#727 sealed decisions):
 *   - 1 active legacy instruction → set `currentInstructionId` on that session
 *   - >1 active                    → `currentInstructionId = null`, all into
 *                                     `instructionHistory`, `source='migration'`,
 *                                     one `lifecycleEvents` `add+confirmed`
 *                                     migration record per instruction
 *
 * Eager startup ordering (see src/index.ts):
 *   acquire startup lock → backup sessions.json → run migration → release →
 *   *then* accept Slack/dashboard traffic.
 *
 * This module is also exposed as `npm run migrate:user-instructions --
 *   --dry-run|--apply` via `scripts/migrate-user-instructions.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from './logger';
import { type LifecycleEvent, type UserInstruction, type UserSessionDoc, UserSessionStore } from './user-session-store';

const logger = new Logger('UserInstructionsMigration');

// ── Legacy session shape (subset we rely on for migration) ──────────────────

export interface LegacyInstruction {
  id: string;
  text: string;
  addedAt: number;
  source?: string;
  /** Legacy enum included `'todo'`; we map it to `'active'` during migration. */
  status?: 'active' | 'todo' | 'completed' | 'cancelled';
  evidence?: string;
  completedAt?: number;
  cancelledAt?: number;
}

export interface LegacySession {
  key: string;
  ownerId?: string;
  /** Pre-ownerId fallback. */
  userId?: string;
  channelId: string;
  threadTs?: string;
  isActive?: boolean;
  lastActivity?: string;
  instructions?: LegacyInstruction[];
  /**
   * If the session has already been migrated in a previous pass it carries
   * these two pointers. We use them to short-circuit re-migration on the
   * idempotent path.
   */
  currentInstructionId?: string | null;
  instructionHistory?: string[];
}

export interface MigrationOptions {
  /** Override the data directory root (test + admin script use this). */
  dataDir: string;
  /** When true, do not write any files (no backup, no user docs). */
  dryRun: boolean;
  /**
   * Override the migration timestamp, primarily for deterministic test
   * snapshots. Defaults to `new Date().toISOString()`.
   */
  now?: () => string;
}

export interface MigrationResult {
  /** Number of distinct users whose user-session.json was created/updated. */
  userIdsTouched: number;
  /** Number of legacy instructions newly projected into the user master this run. */
  newInstructions: number;
  /**
   * Per-session pointer assignments (sessionKey → `{currentInstructionId,
   * instructionHistory}`). The startup wrapper applies these onto the
   * in-memory `sessions.json` payload before SessionRegistry reads it.
   *
   * For dry-run this is still populated so the admin can preview.
   */
  sessionPointers: Record<
    string,
    {
      currentInstructionId: string | null;
      instructionHistory: string[];
    }
  >;
  /** Resolved backup path (when `dryRun=false` AND a sessions.json existed). */
  backupPath?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function defaultNow(): string {
  return new Date().toISOString();
}

function legacyStatusToSealed(status: LegacyInstruction['status']): UserInstruction['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  // 'active', 'todo', undefined → 'active' (sealed migration rule).
  return 'active';
}

function epochToIso(ms: number | undefined, fallback: string): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return fallback;
  try {
    return new Date(ms).toISOString();
  } catch {
    return fallback;
  }
}

function backupSessionsFile(sessionsFile: string, now: string): string {
  // Filename-safe ISO timestamp (replace colons).
  const stamp = now.replace(/[:]/g, '-');
  const backup = `${sessionsFile}.${stamp}.bak`;
  fs.copyFileSync(sessionsFile, backup);
  return backup;
}

// ── Migration ────────────────────────────────────────────────────────────────

/**
 * Run the eager / on-demand migration.
 *
 * Contract:
 * - Reads `${dataDir}/sessions.json`. Missing file → no-op (returns empty result).
 * - On `dryRun=false`, copies `sessions.json` to `sessions.json.<iso>.bak`
 *   BEFORE writing any user docs. Backup failure aborts (no partial state).
 * - For each legacy session that has `instructions[]`, groups by `ownerId
 *   ?? userId` and merges into the per-user `user-session.json`.
 * - Idempotent: instructions already present in the user doc (matched by id)
 *   are not duplicated. Lifecycle events for the same migration receive the
 *   same `id` (`mig_<userId>_<instructionId>_<sessionKey>`) so re-runs
 *   produce the same set.
 * - Returns `sessionPointers` so the caller can apply
 *   `currentInstructionId`/`instructionHistory` onto sessions.json.
 */
export function migrateUserInstructions(opts: MigrationOptions): MigrationResult {
  const now = (opts.now ?? defaultNow)();
  const sessionsFile = path.join(opts.dataDir, 'sessions.json');
  const result: MigrationResult = {
    userIdsTouched: 0,
    newInstructions: 0,
    sessionPointers: {},
  };

  if (!fs.existsSync(sessionsFile)) {
    logger.debug('No sessions.json found — migration is a no-op', { dataDir: opts.dataDir });
    return result;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionsFile, 'utf-8');
  } catch (err) {
    logger.error('Failed to read sessions.json — aborting migration', { error: err });
    throw err;
  }

  let legacy: LegacySession[];
  try {
    legacy = JSON.parse(raw) as LegacySession[];
  } catch (err) {
    logger.error('sessions.json is not valid JSON — aborting migration', { error: err });
    throw err;
  }
  if (!Array.isArray(legacy)) {
    logger.error('sessions.json root must be an array — aborting migration');
    throw new Error('sessions.json root must be an array');
  }

  // Backup BEFORE any user-doc writes (apply mode only).
  if (!opts.dryRun) {
    try {
      result.backupPath = backupSessionsFile(sessionsFile, now);
    } catch (err) {
      logger.error('Failed to backup sessions.json — aborting migration', { error: err });
      throw err;
    }
  }

  const store = new UserSessionStore(opts.dataDir);
  const touchedUsers = new Set<string>();

  // Group legacy sessions by user so each user-session.json is loaded/saved once.
  const byUser = new Map<string, LegacySession[]>();
  for (const session of legacy) {
    const userId = session.ownerId || session.userId;
    if (!userId) continue;
    if (!session.instructions || session.instructions.length === 0) continue;
    const arr = byUser.get(userId);
    if (arr) arr.push(session);
    else byUser.set(userId, [session]);
  }

  for (const [userId, sessions] of byUser.entries()) {
    const doc: UserSessionDoc = store.load(userId);
    const existingIds = new Set(doc.instructions.map((i) => i.id));
    const existingEventIds = new Set(doc.lifecycleEvents.map((e) => e.id));
    let userMutated = false;

    for (const session of sessions) {
      const insts = session.instructions ?? [];
      // Project all instructions onto the user master.
      const projected: UserInstruction[] = [];
      for (const li of insts) {
        if (!li.id || typeof li.text !== 'string') continue;
        if (existingIds.has(li.id)) {
          // Already migrated (idempotent path) — still need it in `projected`
          // for the per-session pointer rule below, so look it up.
          const existing = doc.instructions.find((i) => i.id === li.id);
          if (existing) {
            // Ensure the session is in linkedSessionIds (idempotent).
            UserSessionStore.appendLinkedSession(existing, session.key);
            projected.push(existing);
          }
          continue;
        }

        const sealedStatus = legacyStatusToSealed(li.status);
        const createdAt = epochToIso(li.addedAt, now);
        const newInst: UserInstruction = {
          id: li.id,
          text: li.text,
          status: sealedStatus,
          linkedSessionIds: [session.key],
          createdAt,
          source: 'migration',
          sourceRawInputIds: [],
        };
        if (sealedStatus === 'completed') {
          newInst.completedAt = epochToIso(li.completedAt, createdAt);
          if (li.evidence) newInst.evidence = li.evidence;
        }
        if (sealedStatus === 'cancelled') {
          newInst.cancelledAt = epochToIso(li.cancelledAt, createdAt);
        }
        doc.instructions.push(newInst);
        existingIds.add(li.id);
        projected.push(newInst);
        userMutated = true;
        result.newInstructions += 1;

        // Append a deterministic migration lifecycle event per instruction.
        const evtId = `mig_${userId}_${li.id}_${session.key}`;
        if (!existingEventIds.has(evtId)) {
          const evt: LifecycleEvent = {
            id: evtId,
            instructionId: li.id,
            sessionKey: session.key,
            op: 'add',
            state: 'confirmed',
            at: createdAt,
            by: { type: 'migration', id: 'migration' },
            payload: {
              kind: 'migration',
              legacyStatus: li.status ?? 'active',
              text: li.text,
            },
          };
          doc.lifecycleEvents.push(evt);
          existingEventIds.add(evtId);
        }
      }

      // Per-session pointer rule.
      const activeProjected = projected.filter((p) => p.status === 'active');
      const historyIds = projected.map((p) => p.id);
      if (activeProjected.length === 1) {
        result.sessionPointers[session.key] = {
          currentInstructionId: activeProjected[0].id,
          instructionHistory: historyIds,
        };
      } else {
        result.sessionPointers[session.key] = {
          currentInstructionId: null,
          instructionHistory: historyIds,
        };
      }
    }

    if (userMutated) {
      touchedUsers.add(userId);
      if (!opts.dryRun) {
        store.save(userId, doc);
      }
    } else if (sessions.length > 0) {
      // No new instructions but we still computed pointers (idempotent path).
      // No save needed.
    }
  }

  result.userIdsTouched = touchedUsers.size;
  logger.info('user-instructions migration complete', {
    dataDir: opts.dataDir,
    dryRun: opts.dryRun,
    userIdsTouched: result.userIdsTouched,
    newInstructions: result.newInstructions,
    backup: result.backupPath,
  });

  return result;
}

/**
 * Apply the migration's sessionPointers onto a sessions.json payload in-place.
 * Used by the eager startup wrapper after migration to seed
 * `currentInstructionId` / `instructionHistory` onto each legacy session
 * before SessionRegistry reads it. Returns the number of sessions touched.
 */
export function applySessionPointersToSessionsArray(
  sessions: Array<Record<string, unknown>>,
  sessionPointers: MigrationResult['sessionPointers'],
): number {
  let touched = 0;
  for (const s of sessions) {
    const key = s.key as string | undefined;
    if (!key) continue;
    const ptr = sessionPointers[key];
    if (!ptr) continue;
    // Don't clobber a non-empty pointer set by a previous run (idempotent).
    const before = JSON.stringify({
      c: s.currentInstructionId,
      h: s.instructionHistory,
    });
    if (s.currentInstructionId === undefined) {
      s.currentInstructionId = ptr.currentInstructionId;
    }
    if (!Array.isArray(s.instructionHistory)) {
      s.instructionHistory = ptr.instructionHistory.slice();
    }
    const after = JSON.stringify({
      c: s.currentInstructionId,
      h: s.instructionHistory,
    });
    if (before !== after) touched += 1;
  }
  return touched;
}

/**
 * Eager startup wrapper. Wraps `migrateUserInstructions` + applies the
 * resulting pointers back to sessions.json under a startup lock file.
 *
 * Contract:
 * - Holds an exclusive lock at `${dataDir}/.migration.lock` for the duration.
 * - Atomically rewrites `sessions.json` if any pointer was applied.
 * - Idempotent — safe to call on every boot.
 *
 * Slack/dashboard traffic must NOT be accepted before this resolves
 * (#727 sealed Q7).
 */
export async function runStartupUserInstructionsMigration(opts: {
  dataDir: string;
  now?: () => string;
}): Promise<MigrationResult> {
  const lockFile = path.join(opts.dataDir, '.migration.lock');
  if (!fs.existsSync(opts.dataDir)) {
    fs.mkdirSync(opts.dataDir, { recursive: true });
  }

  // Best-effort exclusive lock — `wx` flag fails if the file already exists.
  let acquired = false;
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    acquired = true;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'EEXIST') {
      logger.warn('Migration lock already held — another process is running migration. Waiting for release.', {
        lockFile,
      });
      // Block briefly until the lock disappears (poll). Bounded by 30s — past
      // that we surface the failure rather than starve startup forever.
      const deadline = Date.now() + 30_000;
      while (fs.existsSync(lockFile) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
      if (fs.existsSync(lockFile)) {
        throw new Error(`Migration lock at ${lockFile} held for >30s — aborting startup migration`);
      }
      // Retry exactly once.
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      acquired = true;
    } else {
      throw err;
    }
  }

  try {
    const result = migrateUserInstructions({
      dataDir: opts.dataDir,
      dryRun: false,
      now: opts.now,
    });

    // Apply pointers onto sessions.json so SessionRegistry sees them on next read.
    const sessionsFile = path.join(opts.dataDir, 'sessions.json');
    if (fs.existsSync(sessionsFile) && Object.keys(result.sessionPointers).length > 0) {
      try {
        const raw = fs.readFileSync(sessionsFile, 'utf-8');
        const arr = JSON.parse(raw) as Array<Record<string, unknown>>;
        const touched = applySessionPointersToSessionsArray(arr, result.sessionPointers);
        if (touched > 0) {
          const tmp = `${sessionsFile}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
          fs.renameSync(tmp, sessionsFile);
          logger.info('Applied session pointers to sessions.json', { touched });
        }
      } catch (err) {
        logger.error('Failed to apply pointers onto sessions.json (migration succeeded)', { error: err });
      }
    }
    return result;
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* lock cleanup best-effort */
      }
    }
  }
}
