/**
 * PID Lock — Single Instance Guard
 *
 * Prevents multiple soma-work processes from running simultaneously
 * with the same Slack token, which causes Socket Mode event
 * round-robin distribution and 50% random errors.
 *
 * @see docs/pid-lock/spec.md
 * @see https://github.com/2lab-ai/soma-work/issues/152
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOCK_FILENAME = 'soma-work.pid';

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
 * Acquire a PID lock. Returns true if lock acquired, false if another instance is running.
 *
 * Behavior:
 * - No lock file → create with current PID → return true
 * - Lock file with dead/invalid PID → remove stale lock → create new → return true
 * - Lock file with alive PID → return false (caller should exit)
 */
export function acquirePidLock(dataDir: string): boolean {
  const lockPath = join(dataDir, LOCK_FILENAME);

  if (existsSync(lockPath)) {
    const content = readFileSync(lockPath, 'utf-8').trim();
    const pid = parseInt(content, 10);

    if (isNaN(pid) || pid <= 0) {
      // Corrupted lock file — treat as stale
      console.warn(`[pid-lock] Corrupted lock file (content="${content}"), removing`);
      unlinkSync(lockPath);
    } else if (pid === process.pid) {
      // Re-entrant call from same process — already ours
      return true;
    } else if (isProcessAlive(pid)) {
      // Another instance is genuinely running
      console.error(`[pid-lock] Another instance already running (pid=${pid}). Exiting.`);
      return false;
    } else {
      // Stale lock — process died without cleanup
      console.warn(`[pid-lock] Stale PID lock detected (pid=${pid}), removing`);
      unlinkSync(lockPath);
    }
  }

  // Write our PID
  writeFileSync(lockPath, String(process.pid), 'utf-8');
  return true;
}

/**
 * Release the PID lock. Only removes if the lock file contains our PID.
 * This prevents accidentally removing another instance's lock.
 */
export function releasePidLock(dataDir: string): void {
  const lockPath = join(dataDir, LOCK_FILENAME);

  if (!existsSync(lockPath)) {
    return;
  }

  const content = readFileSync(lockPath, 'utf-8').trim();
  const pid = parseInt(content, 10);

  if (pid === process.pid) {
    unlinkSync(lockPath);
  }
}
