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
 *   - acquire: write `owner.json` = `{ pid, host, startedAt, token, at }` into a
 *     private temp dir, then `rename` it to `{memoryRoot}/.lock` — atomic, and
 *     the lock never exists without its owner (rename onto a held, non-empty
 *     lock fails).
 *   - release: only when `owner.json` still carries our token.
 *   - abandoned, on this host: the owner pid is dead (after a 1 s grace), or the
 *     pid now belongs to a different process (its start time differs — pid
 *     reuse). A live owner is NEVER taken over by age. Another host's pid cannot
 *     be checked: such a lock is abandoned only after `staleMs` (several hosts
 *     sharing one DATA_DIR is not a supported setup).
 *   - reap: serialized by a second lock (`.lock.reap`); inside it the reaper
 *     re-checks the judged token, moves the lock aside and deletes it. On one
 *     host a judged owner is dead or gone, so it cannot release concurrently —
 *     the reaper can never move a lock taken after its judgement.
 * Re-entrant within one module instance (a write that calls another locked
 * write does not deadlock).
 *
 * Synchronous on purpose: the stores are synchronous, and a lock held across
 * an `await` would be an interleaving hazard.
 */
import { spawnSync } from 'child_process';
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
  /** A lock of ANOTHER host (or an older build) older than this is abandoned (default 60s). */
  staleMs?: number;
}

interface Owner {
  pid?: unknown;
  host?: unknown;
  startedAt?: unknown;
  token?: unknown;
  at?: unknown;
}

const OWNERLESS_MS = 2_000;
const DEAD_GRACE_MS = 1_000;
const REAP_STALE_MS = 5_000;
/** A live owner holding this long is checked for pid reuse (one `ps` call). */
const PID_REUSE_CHECK_MS = 10_000;
const START_TOLERANCE_MS = 3_000;
const HOST = os.hostname();
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

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

/** When the process with `pid` started (ms), or null when it cannot be told. */
function processStartedAt(pid: number): number | null {
  try {
    // C locale: under e.g. ko_KR `ps` prints "2026년 10월 23일 …", which Date.parse cannot read.
    const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 1_000,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', LC_TIME: 'C' },
    });
    const t = Date.parse(String(out.stdout || '').trim());
    return Number.isFinite(t) ? t : null;
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
  if (owner.host !== HOST) return age > staleMs ? token : null;
  if (!pidAlive(owner.pid)) return age > DEAD_GRACE_MS ? token : null;
  // The pid is alive. A live owner is never taken over by age — only when the
  // pid has been reused by another process since the owner recorded its start.
  if (age <= PID_REUSE_CHECK_MS) return null;
  if (typeof owner.startedAt !== 'number') return age > staleMs ? token : null; // owner from an older build
  const started = processStartedAt(owner.pid as number);
  if (started === null) return null;
  return Math.abs(started - owner.startedAt) > START_TOLERANCE_MS ? token : null;
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
    const token = newToken();
    const staged = `${lockPath}.new.${token}`;
    fs.mkdirSync(staged);
    fs.writeFileSync(
      path.join(staged, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: HOST, startedAt: PROCESS_STARTED_AT, token, at: Date.now() }),
    );
    try {
      fs.renameSync(staged, lockPath);
      return token;
    } catch (err) {
      fs.rmSync(staged, { recursive: true, force: true });
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM' && code !== 'EISDIR') throw err;
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
