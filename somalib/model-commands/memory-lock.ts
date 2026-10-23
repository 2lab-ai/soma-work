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
 * Protocol: `mkdir` of `{memoryRoot}/.lock` is the atomic acquire (it fails
 * with EEXIST while someone holds it). The holder writes `owner.json`
 * (`{ pid, at }`). A waiter takes over a lock whose owner process is gone or
 * whose stamp is older than `staleMs` (a holder never keeps it that long — all
 * memory writes are small and synchronous). Re-entrant within one module
 * instance (a write that calls another locked write does not deadlock).
 *
 * Synchronous on purpose: the stores are synchronous, and a lock held across
 * an `await` would be an interleaving hazard.
 */
import * as fs from 'fs';
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
  /** A lock stamped longer ago than this is abandoned (default 30s). */
  staleMs?: number;
}

const held = new Map<string, number>();
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** `{dataDir}/{userId}/memory/.lock` (same root as `memoryRoot`, no import cycle). */
export function memoryLockPath(dataDir: string, userId: string): string {
  if (!isSafeSegment(userId)) throw new Error(`Invalid userId for memory storage: ${userId}`);
  return path.join(dataDir, userId, 'memory', '.lock');
}

function sleepMs(ms: number): void {
  Atomics.wait(SLEEP, 0, 0, ms);
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

function isAbandoned(lockPath: string, staleMs: number): boolean {
  let owner: { pid?: unknown; at?: unknown } | null = null;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf-8'));
  } catch {
    owner = null;
  }
  if (owner) {
    if (typeof owner.at === 'number' && Date.now() - owner.at > staleMs) return true;
    return !pidAlive(owner.pid);
  }
  // No owner file yet: the holder is between mkdir and write — judge by the dir age.
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function acquire(lockPath: string, opts: MemoryLockOptions): void {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30_000;
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (isAbandoned(lockPath, staleMs)) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    const waited = Date.now() - start;
    if (waited >= timeoutMs) throw new MemoryLockTimeoutError(lockPath, waited);
    sleepMs(Math.min(15, timeoutMs - waited));
  }
}

/** Run `fn` holding the user's memory lock. */
export function withMemoryLock<T>(dataDir: string, userId: string, fn: () => T, opts: MemoryLockOptions = {}): T {
  const lockPath = memoryLockPath(dataDir, userId);
  const depth = held.get(lockPath) ?? 0;
  if (depth === 0) acquire(lockPath, opts);
  held.set(lockPath, depth + 1);
  try {
    return fn();
  } finally {
    const left = (held.get(lockPath) ?? 1) - 1;
    if (left === 0) {
      held.delete(lockPath);
      fs.rmSync(lockPath, { recursive: true, force: true });
    } else {
      held.set(lockPath, left);
    }
  }
}
