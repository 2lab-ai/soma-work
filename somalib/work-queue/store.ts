/**
 * The ledger file `DATA_DIR/work-queues.json` (.prd/37 §2.3). Every MCP process (one per session) and the host read
 * and change the same file, so every change runs under one cross-process lock:
 *
 * - `mutate(fn)`: take `<file>.lock` by exclusive create (`wx`); while another process holds it, look again every
 *   `retryMs` up to `lockTimeoutMs` (then `LOCK_TIMEOUT`). A lock file older than `staleLockMs` was left by a process
 *   that died mid-change (a change takes milliseconds) and is taken over. Inside the lock: read → `fn` → when the
 *   ledger changed, copy the good current file to `<file>.bak`, write a temp file, fsync, rename over the live path.
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

  /** The live file's modification time; undefined when there is no file yet. */
  mtimeMs(): number | undefined {
    try {
      return fs.statSync(this.filePath).mtimeMs;
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
    this.lock();
    try {
      const { ledger, liveIsGood } = this.load();
      const { ledger: next, result } = fn(ledger);
      if (next !== ledger) this.write(next, liveIsGood);
      return result;
    } finally {
      this.unlock();
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

  private lock(): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, `${process.pid} ${Date.now()}`);
        fs.closeSync(fd);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (this.takeOverStale()) continue;
      if (Date.now() >= deadline) {
        throw new Error(`LOCK_TIMEOUT: work-queues lock ${this.lockPath} held for over ${this.lockTimeoutMs} ms`);
      }
      sleepSync(this.retryMs);
    }
  }

  /** Remove a lock its process left behind; true when one was removed. */
  private takeOverStale(): boolean {
    try {
      const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
      if (age <= this.staleLockMs) return false;
      fs.rmSync(this.lockPath, { force: true });
      return true;
    } catch {
      // Gone between the create and the stat: try again at once.
      return true;
    }
  }

  private unlock(): void {
    fs.rmSync(this.lockPath, { force: true });
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
