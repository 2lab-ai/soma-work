/**
 * The ledger file `DATA_DIR/work-queues.json` (.prd/37 §2.3). Every MCP process (one per session) and the host read
 * and change the same file, so every change runs under one cross-process lock:
 *
 * - `mutate(fn)`: take `<file>.lock` by exclusive create (`wx`), writing `<pid> <time> <token>` into it; while another
 *   process holds it, look again every `retryMs` up to `lockTimeoutMs` (then `LOCK_TIMEOUT` — the deadline bounds
 *   every path, a takeover too). A lock older than `staleLockMs` whose process is gone was left by a crash mid-change
 *   (a change takes milliseconds): it is renamed aside and removed only if the moved file is the one judged stale —
 *   a fresh lock moved by mistake (another waiter took over first) is put back. A lock of a live process is never
 *   taken. Unlock removes the lock only while it still holds this change's token. Inside the lock: read → `fn` → when
 *   the ledger changed, copy the good current file to `<file>.bak`, write a temp file, fsync, rename over the live
 *   path.
 * - `stamp()`: inode + mtime + size of the live file. Every write is a rename (a new inode), so two writes within one
 *   clock tick still give two stamps.
 * - `read()`: no lock — a rename never shows a half-written file. Missing file = empty ledger. A broken file reads
 *   from `<file>.bak`; with no usable backup it throws — never an empty ledger (rules/config.md 4: an empty read would
 *   let every waiting entry vanish).
 *
 * Synchronous on purpose: both sides run short transactions, and an `await` inside one would hold the lock across
 * other work. `@soma/process-shared` does not depend on `@soma/common`, so this follows `atomic-json`'s tmp → fsync →
 * rename rule rather than importing it.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { emptyLedger, isWorkQueueLedger, type WorkQueueLedger } from './ledger';

export const WORK_QUEUE_FILE = 'work-queues.json';

export interface WorkQueueStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryMs?: number;
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

export class WorkQueueStore {
  private readonly lockPath: string;
  private readonly backupPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly retryMs: number;

  constructor(
    readonly filePath: string,
    options: WorkQueueStoreOptions = {},
  ) {
    this.lockPath = `${filePath}.lock`;
    this.backupPath = `${filePath}.bak`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 3_000;
    this.staleLockMs = options.staleLockMs ?? 10_000;
    this.retryMs = options.retryMs ?? 20;
  }

  /** What the live file is now (inode · mtime · size); undefined when there is no file yet. */
  stamp(): string | undefined {
    try {
      const st = fs.statSync(this.filePath);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
  }

  read(): WorkQueueLedger {
    return this.load().ledger;
  }

  /**
   * Apply `fn` to the current ledger under the lock. `fn` returns the next ledger (the same object = no change, no
   * write) and a result, which `mutate` returns.
   */
  mutate<T>(fn: (ledger: WorkQueueLedger) => { ledger: WorkQueueLedger; result: T }): T {
    const token = this.lock();
    try {
      const { ledger, liveIsGood } = this.load();
      const { ledger: next, result } = fn(ledger);
      if (next !== ledger) this.write(next, liveIsGood);
      return result;
    } finally {
      this.unlock(token);
    }
  }

  private load(): { ledger: WorkQueueLedger; liveIsGood: boolean } {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ledger: emptyLedger(), liveIsGood: false };
      throw error;
    }
    const live = parse(text);
    if (live) return { ledger: live, liveIsGood: true };
    let backup: WorkQueueLedger | undefined;
    try {
      backup = parse(fs.readFileSync(this.backupPath, 'utf8'));
    } catch {
      backup = undefined;
    }
    if (backup) return { ledger: backup, liveIsGood: false };
    throw new Error(`work-queues: ${this.filePath} is unreadable and has no usable backup — not reading it as empty`);
  }

  private write(ledger: WorkQueueLedger, liveIsGood: boolean): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (liveIsGood) fs.copyFileSync(this.filePath, this.backupPath);
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(ledger, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  /** Take the lock; returns the content written into it (this change's token). */
  private lock(): string {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const token = `${process.pid} ${Date.now()} ${randomBytes(6).toString('hex')}`;
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeSync(fd, token);
        } finally {
          fs.closeSync(fd);
        }
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`LOCK_TIMEOUT: work-queues lock ${this.lockPath} held for over ${this.lockTimeoutMs} ms`);
      }
      if (!this.takeOverStale()) sleepSync(this.retryMs);
    }
  }

  /**
   * Remove a lock its process left behind; true when one was removed. Only a lock older than `staleLockMs` whose
   * process is not alive (a crash). The rename makes the takeover atomic: of two waiters only one moves the file,
   * and a waiter that moved a lock other than the one it judged stale puts it back.
   */
  private takeOverStale(): boolean {
    let seen: string;
    try {
      if (Date.now() - fs.statSync(this.lockPath).mtimeMs <= this.staleLockMs) return false;
      seen = fs.readFileSync(this.lockPath, 'utf8');
    } catch {
      return false;
    }
    if (processAlive(Number.parseInt(seen, 10))) return false;
    const aside = `${this.lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(this.lockPath, aside);
    } catch {
      return false;
    }
    let moved = '';
    try {
      moved = fs.readFileSync(aside, 'utf8');
    } catch {
      moved = '';
    }
    if (moved === seen) {
      fs.rmSync(aside, { force: true });
      return true;
    }
    // Another waiter took over between the read and the rename: this is its fresh lock — put it back.
    try {
      fs.linkSync(aside, this.lockPath);
    } catch {
      // A third lock is already there; the moved one's owner will find its token gone and still finish its change.
    }
    fs.rmSync(aside, { force: true });
    return false;
  }

  /** Remove the lock only while it is still this change's. */
  private unlock(token: string): void {
    try {
      if (fs.readFileSync(this.lockPath, 'utf8') === token) fs.rmSync(this.lockPath, { force: true });
    } catch {
      // Gone already.
    }
  }
}

/** A pid that still runs (signal 0 tests without sending); a bad or missing pid reads as not alive. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parse(text: string): WorkQueueLedger | undefined {
  try {
    const value = JSON.parse(text);
    return isWorkQueueLedger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
