import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { migrateLegacyCooldowns } from './migrate';
import type { CctStoreSnapshot } from './types';

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
    version: 1,
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

async function readSnapshot(filePath: string): Promise<CctStoreSnapshot> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as CctStoreSnapshot;
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Single-file, revision-CAS, durable-write store for CCT slot state.
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
   * snapshot and then run legacy-cooldown migration (matching by slot name
   * and renaming the source file). The migration runs on every load but is
   * a no-op once the legacy file has been renamed.
   */
  async load(): Promise<CctStoreSnapshot> {
    await this.ensureDir();
    let snap: CctStoreSnapshot;
    if (await pathExists(this.filePath)) {
      snap = await readSnapshot(this.filePath);
    } else {
      snap = emptySnapshot();
    }
    const dir = path.dirname(this.filePath);
    snap = await migrateLegacyCooldowns(snap, dir);
    return snap;
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
      const actual = (await pathExists(this.filePath)) ? (await readSnapshot(this.filePath)).revision : 0;
      if (actual !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, actual);
      }

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
