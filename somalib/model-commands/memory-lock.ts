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
 * Protocol — the owner file is named after its token, `.lock/owner-<token>.json`,
 * so "remove the lock only if it is still T's" is ONE atomic call:
 * `rename(.lock/owner-T.json, …)` succeeds only while T's lock is in place; a
 * newer owner's lock holds a different file name, so the rename fails (ENOENT).
 *   - acquire: write `owner-<token>.json` = `{ pid, host, startedAt, token, at }`
 *     into a private temp dir, then `rename` it to `{memoryRoot}/.lock` — atomic,
 *     and the lock never exists without its owner (rename onto a held, non-empty
 *     lock fails; onto an empty leftover dir it succeeds).
 *   - release / reap: move our (or the judged) owner file out — the atomic
 *     compare-and-delete — then `rmdir` the now empty dir. If a new owner renamed
 *     its lock onto the emptied dir first, `rmdir` fails (not empty) and that
 *     lock stays. No reaper lock, nothing reclaimed by age on this host: a
 *     reaper frozen between its judgement and its commit just fails the rename
 *     (review R3).
 *   - abandoned, on this host: the owner pid is dead (after a 1 s grace), or the
 *     pid now belongs to a different process (its start time differs — pid
 *     reuse). A live owner is NEVER taken over by age. Another host's pid cannot
 *     be checked: such a lock is abandoned only after `staleMs` (several hosts
 *     sharing one DATA_DIR is not a supported setup). A `.lock` without an owner
 *     file is never removed: empty, the next acquire replaces it; with anything
 *     else in it, writers time out and a human looks.
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

const DEAD_GRACE_MS = 1_000;
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

const OWNER_FILE = /^owner-([A-Za-z0-9-]+)\.json$/;

function ownerFile(lockPath: string, token: string): string {
  return path.join(lockPath, `owner-${token}.json`);
}

/** The lock's owner record and the token its FILE NAME carries (what a compare-and-delete targets). */
function readOwner(lockPath: string): { owner: Owner; token: string } | null {
  let names: string[];
  try {
    names = fs.readdirSync(lockPath);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = OWNER_FILE.exec(name);
    if (!m) continue;
    try {
      return { owner: JSON.parse(fs.readFileSync(path.join(lockPath, name), 'utf-8')) as Owner, token: m[1] };
    } catch {
      return null; // being moved out right now (or unreadable): never judged abandoned on a guess
    }
  }
  return null;
}

/** `rmdir` the lock dir if it is empty; a lock another owner renamed onto it meanwhile stays. */
function removeEmptyLockDir(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw err;
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

/** The token of the holding judged abandoned, or null when it is live (or has no owner file). */
function abandonedToken(lockPath: string, staleMs: number): string | null {
  const found = readOwner(lockPath);
  if (!found) return null;
  const { owner, token } = found;
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
 * Remove the lock only if it is still `judgedToken`'s: move that owner file out
 * (fails once the lock changed hands), then drop the emptied dir. `beforeCommit`
 * is a test seam — a reaper frozen right before its commit.
 */
export function reapIfStill(lockPath: string, judgedToken: string, hooks: { beforeCommit?: () => void } = {}): boolean {
  hooks.beforeCommit?.();
  const grave = `${lockPath}.dead.${newToken()}.json`;
  try {
    fs.renameSync(ownerFile(lockPath, judgedToken), grave);
  } catch {
    return false;
  }
  removeEmptyLockDir(lockPath);
  fs.rmSync(grave, { force: true });
  return true;
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
      ownerFile(staged, token),
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
  // Our owner file is gone only if we were reaped meanwhile — then the lock is someone else's now.
  const grave = `${lockPath}.done.${token}.json`;
  try {
    fs.renameSync(ownerFile(lockPath, token), grave);
  } catch {
    return;
  }
  removeEmptyLockDir(lockPath);
  fs.rmSync(grave, { force: true });
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
