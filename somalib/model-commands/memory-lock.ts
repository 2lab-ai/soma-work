/**
 * Per-user memory lock, shared by every process that writes a user's memory
 * files (SSOT 2026-10-23 T3, design review P1).
 *
 * Writers: the host process (L1 store, semantic pages, the per-turn episodic
 * capture), the model-command MCP subprocess (SAVE_MEMORY / MEMORY), and the
 * dashboard memory tab. All of them run this module, so taking the lock here
 * is the one protocol they share. A dashboard edit reads a file, checks its
 * revision and replaces it inside the lock — an append from another process
 * waits instead of landing between the check and the rename and being lost.
 *
 * Protocol:
 *   - acquire: `mkdir {memoryRoot}/.lock` (atomic; EEXIST while held), then
 *     `owner.json` = `{ pid, host, token, at }` — the token names this holding.
 *   - release: only when `owner.json` still carries our token (a holding that
 *     was reaped never deletes the next owner's lock).
 *   - abandoned: no owner file for `ownerlessMs`; or, on this host, a dead pid
 *     after `deadGraceMs`; or any owner older than `staleMs` (a pid from
 *     another host / namespace is never trusted). Holds are milliseconds — all
 *     memory writes are small and synchronous.
 *   - reap: serialized by a second lock (`.lock.reap`); inside it the reaper
 *     re-checks that the lock still carries the token it judged abandoned,
 *     moves it aside and deletes it. Two waiters can therefore never both
 *     reap, and a reaper never removes a lock taken after its judgement.
 *   Residual (documented, review): an owner judged stale only by age (alive
 *   but hung > `staleMs`) can overlap the next owner if it wakes up mid-write.
 * Re-entrant within one module instance (a write that calls another locked
 * write does not deadlock).
 *
 * Synchronous on purpose: the stores are synchronous, and a lock held across
 * an `await` would be an interleaving hazard.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSafeSegment } from './memory-page-id';

export class MemoryLockTimeoutError extends Error {
  constructor(lockPath: string, waitedMs: number) {
    super(`Memory is busy (another writer holds ${lockPath} for ${waitedMs}ms) — try again`);
    this.name = 'MemoryLockTimeoutError';
  }
}

export interface MemoryLockOptions {
  /** Give up after this long (default 5s). */
  timeoutMs?: number;
  /** An owner stamped longer ago than this is abandoned, whatever its pid (default 60s). */
  staleMs?: number;
}

interface Owner {
  pid?: unknown;
  host?: unknown;
  token?: unknown;
  at?: unknown;
}

const OWNERLESS_MS = 2_000;
const DEAD_GRACE_MS = 1_000;
const REAP_STALE_MS = 5_000;
const HOST = os.hostname();

const held = new Map<string, { depth: number; token: string }>();
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** `{dataDir}/{userId}/memory/.lock` (same root as `memoryRoot`, no import cycle). */
export function memoryLockPath(dataDir: string, userId: string): string {
  if (!isSafeSegment(userId)) throw new Error(`Invalid userId for memory storage: ${userId}`);
  return path.join(dataDir, userId, 'memory', '.lock');
}

function sleepMs(ms: number): void {
  Atomics.wait(SLEEP, 0, 0, ms);
}

function newToken(): string {
  return `${process.pid}-${randomBytes(8).toString('hex')}`;
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockPath: string): Owner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf-8')) as Owner;
  } catch {
    return null;
  }
}

/** The token of the holding judged abandoned (`''` for an ownerless lock), or null when it is live. */
function abandonedToken(lockPath: string, staleMs: number): string | null {
  const owner = readOwner(lockPath);
  if (!owner) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > OWNERLESS_MS ? '' : null;
    } catch {
      return null;
    }
  }
  const token = typeof owner.token === 'string' ? owner.token : '';
  const age = typeof owner.at === 'number' ? Date.now() - owner.at : Number.POSITIVE_INFINITY;
  if (age > staleMs) return token;
  if (owner.host === HOST && !pidAlive(owner.pid) && age > DEAD_GRACE_MS) return token;
  return null;
}

/**
 * Remove the lock only if it still carries `judgedToken`. Serialized by the
 * reaper lock; returns false when another reaper is at work or the lock has
 * changed hands since it was judged.
 */
export function reapIfStill(lockPath: string, judgedToken: string): boolean {
  const reapLock = `${lockPath}.reap`;
  try {
    fs.mkdirSync(reapLock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // A reaper that died mid-reap: its own lock is tiny-lived.
    try {
      if (Date.now() - fs.statSync(reapLock).mtimeMs > REAP_STALE_MS)
        fs.rmSync(reapLock, { recursive: true, force: true });
    } catch {
      /* gone already */
    }
    return false;
  }
  try {
    const owner = readOwner(lockPath);
    const current = owner && typeof owner.token === 'string' ? owner.token : '';
    if (!fs.existsSync(lockPath) || current !== judgedToken) return false;
    const grave = `${lockPath}.dead.${newToken()}`;
    try {
      fs.renameSync(lockPath, grave);
    } catch {
      return false;
    }
    fs.rmSync(grave, { recursive: true, force: true });
    return true;
  } finally {
    fs.rmSync(reapLock, { recursive: true, force: true });
  }
}

function acquire(lockPath: string, opts: MemoryLockOptions): string {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 60_000;
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      const token = newToken();
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({ pid: process.pid, host: HOST, token, at: Date.now() }),
      );
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const judged = abandonedToken(lockPath, staleMs);
    if (judged !== null && reapIfStill(lockPath, judged)) continue;
    const waited = Date.now() - start;
    if (waited >= timeoutMs) throw new MemoryLockTimeoutError(lockPath, waited);
    sleepMs(Math.min(15, timeoutMs - waited));
  }
}

function release(lockPath: string, token: string): void {
  const owner = readOwner(lockPath);
  if (!owner || owner.token !== token) return; // reaped meanwhile — the lock is someone else's now
  const grave = `${lockPath}.done.${token}`;
  try {
    fs.renameSync(lockPath, grave);
  } catch {
    return;
  }
  fs.rmSync(grave, { recursive: true, force: true });
}

/** Run `fn` holding the user's memory lock. */
export function withMemoryLock<T>(dataDir: string, userId: string, fn: () => T, opts: MemoryLockOptions = {}): T {
  const lockPath = memoryLockPath(dataDir, userId);
  const mine = held.get(lockPath);
  if (mine) {
    mine.depth += 1;
  } else {
    held.set(lockPath, { depth: 1, token: acquire(lockPath, opts) });
  }
  try {
    return fn();
  } finally {
    const h = held.get(lockPath);
    if (h) {
      h.depth -= 1;
      if (h.depth === 0) {
        held.delete(lockPath);
        release(lockPath, h.token);
      }
    }
  }
}
