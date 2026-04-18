/**
 * Pidfile enforcement (D18).
 *
 * `fs.openSync(path, 'wx')` is atomic and fails if the file already exists.
 * If a stale pidfile remains from a prior crash we verify its owner PID is
 * actually gone before unlinking and retrying.
 *
 * This module does NOT install signal handlers — the graceful shutdown path
 * in shutdown.ts owns the unlink, gated on drain completion, so the pidfile
 * lives until all in-flight work has been persisted. That prevents a
 * replacement server from acquiring the lock mid-shutdown (split-brain).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StderrLogger } from '../../_shared/stderr-logger.js';

const DEFAULT_DIR = path.join(os.homedir(), '.soma-work');
const DEFAULT_FILE = 'llm-mcp-server.pid';

const logger = new StderrLogger('Pidfile');

export interface PidfileHandle {
  readonly path: string;
  readonly pid: number;
  /**
   * Best-effort unlink. Only removes the file if its current content still
   * names this process. Callers MUST NOT call this before drain completes.
   */
  release(): void;
}

export function defaultPidfilePath(): string {
  return path.join(DEFAULT_DIR, DEFAULT_FILE);
}

export function acquirePidfile(pidPath: string = defaultPidfilePath()): PidfileHandle {
  const dir = path.dirname(pidPath);
  fs.mkdirSync(dir, { recursive: true });

  const myPid = process.pid;

  const tryOpen = (): number => fs.openSync(pidPath, 'wx');

  let fd: number;
  try {
    fd = tryOpen();
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;

    // A concurrent process may have just done `openSync('wx')` but not yet
    // written its PID — the file is briefly empty. If we unlinked on empty
    // we'd open a split-brain window: the racer would finish writing to a
    // file we've already unlinked, and both instances would proceed believing
    // they hold the lock. Retry-read with tight backoff to let the legit
    // writer finish (writeSync completes within microseconds in practice).
    let raw = '';
    const readDeadline = Date.now() + 500;
    while (Date.now() < readDeadline) {
      try { raw = fs.readFileSync(pidPath, 'utf-8').trim(); } catch { /* ignore */ }
      if (raw) break;
      // busy-wait with short sleep — intentionally sync to match the rest of
      // this function's sync boot semantics.
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
    const oldPid = Number(raw);
    if (!Number.isFinite(oldPid) || oldPid <= 0 || !Number.isInteger(oldPid)) {
      // Still empty/unparseable after 500ms of retries. Either a legit writer
      // is crash-wedged mid-boot or the file is corrupt. Fail-closed: exit(1)
      // is strictly safer than unlinking and potentially stomping on an
      // in-progress racer. An operator can inspect/remove the file manually.
      logger.error('llm.process.pidfile-unreadable', { pidfile: pidPath, raw: raw.slice(0, 40) });
      process.exit(1);
    }
    if (oldPid !== myPid) {
      let ownerAlive = false;
      try {
        process.kill(oldPid, 0);
        ownerAlive = true;
      } catch {
        // kill(pid, 0) threw → owner process is gone, the pidfile is stale.
      }
      if (ownerAlive) {
        // Live owner — refuse to proceed. process.exit must be outside the
        // try/catch above so a spied/mocked process.exit cannot have its
        // throw silently swallowed by the stale-detection catch clause.
        logger.error('llm.process.already-running', { pid: oldPid, pidfile: pidPath });
        process.exit(1);
      }
    }
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
    fd = tryOpen();
  }

  try {
    fs.writeSync(fd, String(myPid));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  logger.info('llm.process.start', { pid: myPid, pidfile: pidPath });

  return {
    path: pidPath,
    pid: myPid,
    release(): void {
      try {
        const raw = fs.readFileSync(pidPath, 'utf-8').trim();
        const owner = Number(raw);
        if (owner === myPid) {
          fs.unlinkSync(pidPath);
        }
      } catch {
        // File already gone or unreadable — best-effort only.
      }
    },
  };
}
