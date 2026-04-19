import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { migrateLegacyCooldowns } from './migrate';
import { migrateV1ToV2 } from './migrate-v2';
import type { CctStoreSnapshot, LegacyV1Snapshot, LegacyV1TokenSlot, PersistedSnapshot, SlotState } from './types';

const MAX_CAS_RETRIES = 5;
const CAS_BACKOFF_MS = 20;

export class RevisionConflictError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`CctStore revision conflict: expected=${expected} actual=${actual}`);
    this.name = 'RevisionConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

function emptySnapshot(): CctStoreSnapshot {
  return {
    version: 2,
    revision: 0,
    registry: { slots: [] },
    state: {},
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the on-disk JSON as-is (either v1 or v2). Unlike {@link readSnapshot},
 * this does NOT run the v1 → v2 migrator — callers (notably {@link CctStore.save}'s
 * CAS pre-check) need to see the raw on-disk `version` and `revision` to
 * decide if another writer has raced them.
 */
async function readSnapshotRaw(filePath: string): Promise<PersistedSnapshot> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as PersistedSnapshot;
}

/**
 * Guard against a pathological on-disk shape where `version: 2` coexists with
 * a v1-styled body (slots keyed by `slotId`/`value`, registry with
 * `activeSlotId`, absent `state`). This is not a shape any code path in the
 * current tree emits, but it has been observed in the wild — typically when
 * an operator hand-edits `cct-store.json` (or a short-lived PR that wrote v2
 * prematurely gets reverted, leaving the next boot staring at a mislabelled
 * v1 body). Without this guard, `load()` would trust the declared version,
 * skip migration, and downstream `snap.state[slot.keyId]` blows up with the
 * diagnostic-hostile `Cannot read properties of undefined (reading 'undefined')`.
 *
 * The repair strategy is deliberately narrow:
 *   - v1-shaped slots present → relabel the snapshot as v1 so the normal
 *     `migrateV1ToV2` path handles it (and persists the canonical v2 shape).
 *   - v2-shaped body with `state` missing → fill in `{}` and return; callers
 *     treat this as a non-migration load, so the repair is only persisted on
 *     the next write.
 */
function reinterpretIfMalformed(raw: PersistedSnapshot): PersistedSnapshot {
  if (raw.version !== 2) return raw;

  const slots = (raw.registry as { slots?: unknown[] } | undefined)?.slots;
  const hasV1Slots =
    Array.isArray(slots) &&
    slots.length > 0 &&
    slots.every(
      (s) =>
        typeof (s as { slotId?: unknown })?.slotId === 'string' &&
        typeof (s as { keyId?: unknown })?.keyId !== 'string',
    );

  if (hasV1Slots) {
    console.warn(
      'cct-store: on-disk file claims version:2 but body is v1-shaped — ' +
        're-running v1→v2 migration. Check for a stray manual edit or an aborted schema rollout.',
    );
    const registry = raw.registry as { activeSlotId?: string; activeKeyId?: string; slots?: unknown[] };
    const activeSlotId = registry.activeSlotId ?? registry.activeKeyId;
    const state = ((raw as { state?: Record<string, SlotState> }).state ?? {}) as Record<string, SlotState>;
    const v1: LegacyV1Snapshot = {
      version: 1,
      revision: raw.revision,
      registry: {
        slots: slots as LegacyV1TokenSlot[],
        ...(activeSlotId !== undefined ? { activeSlotId } : {}),
      },
      state,
    };
    return v1;
  }

  // Well-formed v2 with an absent state map: normalise so every downstream
  // `snap.state[keyId]` read is well-defined. We return a new object; the
  // caller decides whether to persist (load() currently does not, which keeps
  // the happy path zero-write).
  if ((raw as { state?: unknown }).state === undefined) {
    return { ...(raw as CctStoreSnapshot), state: {} };
  }
  return raw;
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Single-file, revision-CAS, durable-write store for AuthKey slot state.
 *
 * Concurrency model:
 *   - `withLock` acquires an inter-process advisory lock via `proper-lockfile`
 *     on `${filePath}.lock`. Inside the lock it is safe to read-then-write
 *     without another process racing you.
 *   - `save(expected, next)` enforces optimistic CAS on `revision`: if the
 *     on-disk revision differs from `expected`, it throws
 *     `RevisionConflictError`. `save` holds the lock internally so callers
 *     of `save()` do not need to pre-lock.
 *   - `mutate(fn)` = load + deep-clone + apply + increment revision + save,
 *     retrying up to 5 times on CAS conflict with short jittered backoff.
 *
 * Schema-v2 upgrade path:
 *   - `load()` reads raw bytes, runs the legacy-cooldown migrator, then the
 *     v1 → v2 AuthKey migrator. When either migration did real work we
 *     persist the v2 result under the lock (CAS on the v1 revision) so the
 *     next caller never has to re-run the migration. If another process
 *     upgraded the file concurrently we short-circuit and return their v2
 *     output instead of writing our own.
 */
export class CctStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  /** Absolute path to the JSON file that backs this store. */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Load the current snapshot. If the file is missing we synthesize an empty
   * v2 snapshot. Migrations run in order:
   *   1. `migrateLegacyCooldowns` — fold legacy `token-cooldowns.json`.
   *   2. `migrateV1ToV2` — rewrite v1 TokenSlot into v2 AuthKey.
   * When either migration mutated the snapshot we persist the v2 result
   * under the lock so subsequent reads are migration-free.
   */
  async load(): Promise<CctStoreSnapshot> {
    await this.ensureDir();
    let raw: PersistedSnapshot;
    if (await pathExists(this.filePath)) {
      raw = await readSnapshotRaw(this.filePath);
    } else {
      raw = emptySnapshot();
    }

    // Repair a mislabelled v2 body (observed in the wild after manual edits)
    // BEFORE any downstream consumer trusts `raw.version`.
    raw = reinterpretIfMalformed(raw);

    const dir = path.dirname(this.filePath);
    const cooldownResult = await migrateLegacyCooldowns(raw, dir);
    const legacyRan = cooldownResult.didRename;
    raw = cooldownResult.snapshot;

    const wasV1 = raw.version === 1;
    const v2InMemory: CctStoreSnapshot = wasV1 ? migrateV1ToV2(raw) : (raw as CctStoreSnapshot);

    if (wasV1 || legacyRan) {
      return await this.persistMigrated(v2InMemory, wasV1);
    }
    return v2InMemory;
  }

  /**
   * CAS-write the snapshot. `expectedRevision` must match the revision
   * currently on disk (or 0 if the file is absent). Throws
   * `RevisionConflictError` otherwise.
   *
   * Write sequence (durable):
   *   1. acquire inter-process lock
   *   2. re-read file; verify revision
   *   3. write to `${filePath}.tmp.<hex>`; fsync; close
   *   4. rename tmp -> filePath
   *   5. best-effort fsync the parent directory
   *   6. release lock
   */
  async save(expectedRevision: number, next: CctStoreSnapshot): Promise<void> {
    await this.ensureDir();
    // Ensure the target file exists before proper-lockfile (with realpath)
    // can resolve the lock directory. proper-lockfile locks the *file*, not
    // the .lock path, via realpath+suffix, so the file must exist.
    await this.ensureFileForLock();

    const release = await lockfile.lock(this.filePath, {
      lockfilePath: this.lockPath,
      stale: 30_000,
      update: 5_000,
      realpath: true,
      retries: { retries: 50, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      const actual = (await pathExists(this.filePath)) ? (await readSnapshotRaw(this.filePath)).revision : 0;
      if (actual !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, actual);
      }

      await this.writeAtomic(next);
    } finally {
      await release();
    }
  }

  /**
   * Read-modify-write with CAS retry.
   *
   * The callback receives a DEEP-CLONED snapshot so that retaining a
   * reference after `mutate` returns cannot corrupt the store. On
   * `RevisionConflictError` we reload and retry up to 5 times with a
   * short jittered backoff; other errors propagate.
   */
  async mutate<T>(fn: (snap: CctStoreSnapshot) => Promise<T> | T): Promise<T> {
    let lastConflict: RevisionConflictError | null = null;
    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
      const current = await this.load();
      const working = deepClone(current);
      const result = await fn(working);
      working.revision = current.revision + 1;
      try {
        await this.save(current.revision, working);
        return result;
      } catch (err) {
        if (err instanceof RevisionConflictError) {
          lastConflict = err;
          if (attempt < MAX_CAS_RETRIES) {
            const jitter = Math.floor(Math.random() * CAS_BACKOFF_MS);
            await new Promise((resolve) => setTimeout(resolve, CAS_BACKOFF_MS + jitter));
            continue;
          }
          throw err;
        }
        throw err;
      }
    }
    // Unreachable — the loop either returns or throws — but keep TS happy.
    throw lastConflict ?? new Error('CctStore.mutate: exhausted retries');
  }

  /**
   * Run `fn` under the inter-process advisory lock. Use this when you need
   * to perform multi-step work (e.g. load + decide + call save explicitly)
   * without another process racing you. Most callers should prefer
   * `mutate` for simple read-modify-write flows.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    await this.ensureFileForLock();
    const release = await lockfile.lock(this.filePath, {
      lockfilePath: this.lockPath,
      stale: 30_000,
      update: 5_000,
      realpath: true,
      retries: { retries: 50, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  // ── internals ────────────────────────────────────────────────

  /**
   * Persist the result of a v1 → v2 (or legacy-cooldown) migration under
   * the advisory lock.
   *
   * We CAS on the pre-migration revision:
   *   - If the on-disk shape is still v1 and the revision matches, we
   *     write `v2InMemory` at the same revision (migration adds no
   *     semantic work, so we do not bump it).
   *   - If another process already promoted the file to v2, we short-
   *     circuit: return their v2 snapshot (reloaded) instead of ours.
   *   - If the v1 file has advanced past our expected revision, someone
   *     else raced the cooldown migration — drop our v2 attempt and
   *     re-migrate from the new raw snapshot.
   */
  private async persistMigrated(v2InMemory: CctStoreSnapshot, wasV1: boolean): Promise<CctStoreSnapshot> {
    await this.ensureFileForLock();
    const release = await lockfile.lock(this.filePath, {
      lockfilePath: this.lockPath,
      stale: 30_000,
      update: 5_000,
      realpath: true,
      retries: { retries: 50, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      // Re-read under the lock, and repair any mislabelled v2 body so we
      // don't short-circuit into a malformed snapshot on the "race-won" path
      // below.
      const diskRaw = (await pathExists(this.filePath))
        ? reinterpretIfMalformed(await readSnapshotRaw(this.filePath))
        : emptySnapshot();

      // Race-won path: another writer already upgraded the file to v2.
      // Prefer their snapshot over our in-memory copy so we don't clobber
      // writes they may have applied after migration.
      if (wasV1 && diskRaw.version === 2) {
        return diskRaw;
      }

      // If the disk revision advanced beyond what we loaded, re-migrate
      // from the fresh raw snapshot.
      if (diskRaw.revision !== v2InMemory.revision) {
        const dir = path.dirname(this.filePath);
        const cooldownResult = await migrateLegacyCooldowns(diskRaw, dir);
        const raced = cooldownResult.snapshot;
        const v2Raced: CctStoreSnapshot = raced.version === 1 ? migrateV1ToV2(raced) : (raced as CctStoreSnapshot);
        // Only write if we still need to upgrade.
        if (raced.version === 1 || cooldownResult.didRename) {
          await this.writeAtomic(v2Raced);
        }
        return v2Raced;
      }

      await this.writeAtomic(v2InMemory);
      return v2InMemory;
    } finally {
      await release();
    }
  }

  private async writeAtomic(next: CctStoreSnapshot): Promise<void> {
    const tmp = `${this.filePath}.tmp.${randomHex(8)}`;
    const fd = await fs.open(tmp, 'w');
    try {
      await fd.writeFile(JSON.stringify(next, null, 2));
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.rename(tmp, this.filePath);
    await this.fsyncDir(path.dirname(this.filePath));
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  /**
   * proper-lockfile with realpath:true requires the target file to exist.
   * Create an empty-snapshot file if none is present — callers can still
   * overwrite it atomically via save().
   */
  private async ensureFileForLock(): Promise<void> {
    if (await pathExists(this.filePath)) return;
    const tmp = `${this.filePath}.tmp.${randomHex(8)}`;
    const fd = await fs.open(tmp, 'w');
    try {
      await fd.writeFile(JSON.stringify(emptySnapshot(), null, 2));
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      // Raced with another process creating it — clean up our tmp and move on.
      await fs.rm(tmp, { force: true });
      if (!(await pathExists(this.filePath))) throw err;
    }
  }

  private async fsyncDir(dir: string): Promise<void> {
    try {
      const parentFd = await fs.open(dir, 'r');
      try {
        await parentFd.sync();
      } finally {
        await parentFd.close();
      }
    } catch (err) {
      // Directory fsync is not supported on all platforms (notably Windows).
      // Swallow and log at debug level — data durability on POSIX is our
      // primary target.
      if (process.env.CCT_STORE_DEBUG) {
        console.debug('cct-store: parent directory fsync failed (ignored)', err);
      }
    }
  }
}
