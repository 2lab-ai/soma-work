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
 * @see docs/current/plans/pid-lock/spec.md
 * @see https://github.com/2lab-ai/soma-work/issues/152
 */

import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';
import {
  currentDaemonInstance,
  formatPidLockContent,
  PID_LOCK_FILENAME,
  parsePidLockContent,
  sameDaemonInstance,
} from './service-readiness';

/**
 * Re-exported so the lock's filename has exactly one owner
 * (`src/service-readiness.ts`) shared by the daemon, the controller, and their
 * tests. A private literal here is how the service manager and the daemon end
 * up disagreeing about which file is the lock after a rename.
 */
export const LOCK_FILENAME = PID_LOCK_FILENAME;
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
 * Build lock file content: `<pid>:<processStartMs>`.
 *
 * The second field is the process's START time (`now - uptime`), not the moment
 * the lock was written. Both values differ across runs, so either would catch a
 * *restarted* daemon — but only the start time is comparable to something an
 * outside observer can obtain about a candidate process (its own start, or the
 * machine's boot time). The service manager relies on that comparison before it
 * sends SIGTERM to a PID a stale lock names, so "when we happened to write" is
 * not good enough.
 */
function buildLockContent(): string {
  return formatPidLockContent(currentDaemonInstance());
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
 */
export function acquirePidLock(dataDir: string): boolean {
  // Ensure data directory exists (first boot safety)
  mkdirSync(dataDir, { recursive: true });

  const lockPath = join(dataDir, LOCK_FILENAME);
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
    // Same PID number — but is it the same RUN? A stale lock left by a crashed
    // daemon can name a PID the OS later hands to this one. Treating that as
    // re-entrancy leaves the OLD instance in the lock while the readiness
    // marker publishes the NEW one, and the controller's gate compares the two
    // exactly: a perfectly healthy daemon would never be seen as ready.
    const recorded = parsePidLockContent(existingContent);
    if (sameDaemonInstance(recorded, currentDaemonInstance())) {
      return true; // genuinely re-entrant
    }
    // Stale-by-identity: replace it with ours, atomically, before returning.
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
    return tryAtomicCreate(lockPath, content);
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
export function releasePidLock(dataDir: string): void {
  const lockPath = join(dataDir, LOCK_FILENAME);

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
