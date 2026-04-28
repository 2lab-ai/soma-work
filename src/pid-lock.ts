/**
 * PID Lock — Single Instance Guard
 *
 * Prevents multiple soma-work processes from running simultaneously
 * with the same Slack token, which causes Socket Mode event
 * round-robin distribution and 50% random errors.
 *
 * Uses O_EXCL (exclusive create) for atomic lock acquisition to prevent
 * TOCTOU race conditions between concurrent process starts.
 *
 * @see docs/pid-lock/spec.md
 * @see https://github.com/2lab-ai/soma-work/issues/152
 */

import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';

const LOCK_FILENAME = 'soma-work.pid';
const logger = new Logger('PidLock');

/**
 * Check if a process with the given PID is alive.
 * Uses signal 0 which doesn't actually send a signal,
 * but throws ESRCH if the process doesn't exist.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build lock file content: "PID:startTime" format.
 * startTime is process uptime anchor to mitigate PID reuse false positives.
 */
function buildLockContent(): string {
  // Use process.pid + Date.now() as a simple identity tuple.
  // On PID reuse, the start time will differ.
  return `${process.pid}:${Date.now()}`;
}

/**
 * Parse lock file content. Returns { pid, startTime } or null if corrupted.
 */
function parseLockContent(content: string): { pid: number; startTime: number } | null {
  const trimmed = content.trim();

  // Support legacy format (bare PID) for backward compatibility
  if (!trimmed.includes(':')) {
    const pid = parseInt(trimmed, 10);
    return isNaN(pid) || pid <= 0 ? null : { pid, startTime: 0 };
  }

  const [pidStr, timeStr] = trimmed.split(':');
  const pid = parseInt(pidStr, 10);
  const startTime = parseInt(timeStr, 10);

  if (isNaN(pid) || pid <= 0 || isNaN(startTime)) {
    return null;
  }

  return { pid, startTime };
}

/**
 * Attempt atomic file creation using O_CREAT | O_EXCL | O_WRONLY.
 * Returns true if the file was created (we won the race), false if it already existed.
 * Throws on other filesystem errors.
 */
function tryAtomicCreate(lockPath: string, content: string): boolean {
  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    const buf = Buffer.from(content, 'utf-8');
    const { writeSync } = require('fs');
    writeSync(fd, buf);
    closeSync(fd);
    return true;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      return false; // Another process created it first
    }
    throw err; // Permission error, disk full, etc.
  }
}

/**
 * Acquire a PID lock. Returns true if lock acquired, false if another instance is running.
 *
 * Strategy:
 * 1. Try atomic create (O_EXCL) — if we win, lock is ours
 * 2. If file exists, read and validate the incumbent:
 *    - Dead/invalid PID → remove stale lock, retry atomic create
 *    - Alive PID → return false (caller should exit)
 *
 * The optional `lockName` lets callers reuse the same liveness-checked lock
 * for non-default purposes (e.g. user-instructions migration uses
 * `'user-instructions-migration.pid'`). When omitted, defaults to the
 * single-instance-guard `soma-work.pid` filename.
 */
export function acquirePidLock(dataDir: string, lockName: string = LOCK_FILENAME): boolean {
  // Ensure data directory exists (first boot safety)
  mkdirSync(dataDir, { recursive: true });

  const lockPath = join(dataDir, lockName);
  const content = buildLockContent();

  // Attempt 1: Try atomic create
  if (tryAtomicCreate(lockPath, content)) {
    return true;
  }

  // File already exists — inspect the incumbent
  let existingContent: string;
  try {
    existingContent = readFileSync(lockPath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // File disappeared between our EEXIST and read — retry
      return tryAtomicCreate(lockPath, content);
    }
    throw err;
  }

  const parsed = parseLockContent(existingContent);

  if (!parsed) {
    // Corrupted lock file — treat as stale
    logger.warn(`[pid-lock] Corrupted lock file (content="${existingContent.trim()}"), removing`);
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore if already gone */
    }
    return tryAtomicCreate(lockPath, content);
  }

  if (parsed.pid === process.pid) {
    // Re-entrant call from same process — already ours
    return true;
  }

  if (isProcessAlive(parsed.pid)) {
    // Another instance is genuinely running
    logger.error(`[pid-lock] Another instance already running (pid=${parsed.pid}). Exiting.`);
    return false;
  }

  // Stale lock — process died without cleanup
  logger.warn(`[pid-lock] Stale PID lock detected (pid=${parsed.pid}), removing`);
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore if already gone */
  }
  return tryAtomicCreate(lockPath, content);
}

/**
 * Release the PID lock. Only removes if the lock file contains our PID.
 * This prevents accidentally removing another instance's lock.
 */
export function releasePidLock(dataDir: string, lockName: string = LOCK_FILENAME): void {
  const lockPath = join(dataDir, lockName);

  try {
    const content = readFileSync(lockPath, 'utf-8');
    const parsed = parseLockContent(content);
    if (parsed && parsed.pid === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    // File missing or unreadable — nothing to release
  }
}

/**
 * Wrap an async function in a named PID lock. The lock is reclaimed
 * automatically if a previous holder died (stale lock detection via
 * `process.kill(pid, 0)`), eliminating the deadlock window the wx-flag +
 * 30s polling implementation suffered from on `kill -9`.
 *
 * Throws when another LIVE instance currently holds the lock — the caller
 * (e.g. eager-boot wrapper) decides whether to surface the error or wait.
 *
 * Both the happy path and the error path release the lock so callers
 * cannot leak a stale lock by failing during the critical section.
 */
export async function withPidLock<T>(dataDir: string, lockName: string, fn: () => Promise<T>): Promise<T> {
  const acquired = acquirePidLock(dataDir, lockName);
  if (!acquired) {
    throw new Error(`[pid-lock] Could not acquire ${lockName} in ${dataDir} — another live process holds it`);
  }
  try {
    return await fn();
  } finally {
    releasePidLock(dataDir, lockName);
  }
}
