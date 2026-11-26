/**
 * The ledger database `DATA_DIR/work-queues.sqlite3` (.prd/37 §2.3). Every MCP process (one per session) and the host
 * read and change the same ledger, so it lives in SQLite (`node:sqlite`, as the metrics store does):
 *
 * - `mutate(fn)`: one `BEGIN IMMEDIATE` transaction — read the ledger, apply `fn` (a pure transition from
 *   `ledger.ts`), write it back with the revision + 1, commit. SQLite's file locks serialize writers across processes
 *   and the OS releases them when a process dies, so there is no lock file to go stale, nothing to take over, and a
 *   crash mid-change rolls back. A writer that finds the database busy waits up to `busyTimeoutMs`.
 * - `read()`: the committed ledger (WAL: readers never wait for a writer). No row yet = empty ledger. A v1 ledger reads
 *   as v2 (`parseWorkQueueLedger`). A stored ledger of the wrong shape throws — never an empty ledger (rules/config.md 4: an empty read would let every waiting entry
 *   vanish).
 * - `stamp()`: the revision, which moves on every commit — the host re-reads only when it changed.
 *
 * The ledger is one JSON row: the transitions stay pure and whole-ledger, and SQLite supplies atomicity, durability
 * and locking.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { emptyLedger, parseWorkQueueLedger, type WorkQueueLedger } from './ledger';

export const WORK_QUEUE_FILE = 'work-queues.sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
  if (sqlite !== undefined) return sqlite;
  try {
    // biome-ignore lint/style/noCommonJs: optional builtin, absent before Node 22.5 (as in the metrics store)
    sqlite = require('node:sqlite') as SqliteModule;
  } catch {
    sqlite = null;
  }
  return sqlite;
}

/**
 * True when this runtime can keep the ledger (`node:sqlite`, Node >= 22.5). Without it the host keeps no work queue
 * and the tools say so (`QUEUE_UNAVAILABLE`) — a per-process fallback could not be shared between sessions.
 */
export function workQueueStoreAvailable(): boolean {
  return loadSqlite() !== null;
}

export interface WorkQueueStoreOptions {
  /** How long a writer waits for another writer's transaction. */
  busyTimeoutMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  rev  INTEGER NOT NULL,
  body TEXT NOT NULL
)`;

export class WorkQueueStore {
  private db?: DatabaseSync;
  private readonly busyTimeoutMs: number;

  constructor(
    readonly filePath: string,
    options: WorkQueueStoreOptions = {},
  ) {
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  }

  /** The committed revision; undefined while nothing was ever written. */
  stamp(): string | undefined {
    const row = this.open().prepare('SELECT rev FROM ledger WHERE id = 1').get() as { rev?: number } | undefined;
    return row?.rev === undefined ? undefined : String(row.rev);
  }

  read(): WorkQueueLedger {
    return this.load(this.open());
  }

  /**
   * Apply `fn` to the current ledger in one transaction. `fn` returns the next ledger (the same object = no change,
   * nothing written) and a result, which `mutate` returns. A throw rolls the transaction back.
   */
  mutate<T>(fn: (ledger: WorkQueueLedger) => { ledger: WorkQueueLedger; result: T }): T {
    const db = this.open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const ledger = this.load(db);
      const { ledger: next, result } = fn(ledger);
      if (next !== ledger) {
        db.prepare(
          `INSERT INTO ledger (id, rev, body) VALUES (1, 1, ?)
           ON CONFLICT(id) DO UPDATE SET rev = rev + 1, body = excluded.body`,
        ).run(JSON.stringify(next));
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back (SQLite does on some errors).
      }
      throw error;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private load(db: DatabaseSync): WorkQueueLedger {
    const row = db.prepare('SELECT body FROM ledger WHERE id = 1').get() as { body?: string } | undefined;
    if (!row?.body) return emptyLedger();
    let value: unknown;
    try {
      value = JSON.parse(row.body);
    } catch {
      value = undefined;
    }
    try {
      // A v1 ledger (.prd/36 v1) reads as v2; the next change writes it back as v2.
      return parseWorkQueueLedger(value);
    } catch {
      throw new Error(`work-queues: ${this.filePath} holds a ledger of the wrong shape — not reading it as empty`);
    }
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    const sqliteModule = loadSqlite();
    if (!sqliteModule) throw new Error('QUEUE_UNAVAILABLE: this runtime has no node:sqlite (Node >= 22.5)');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new sqliteModule.DatabaseSync(this.filePath);
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(this.busyTimeoutMs))}`);
      // Switching a new file to WAL and creating the table take a lock SQLite does not wait for (its deadlock rule):
      // processes opening a fresh database at once retry here, up to the busy timeout.
      const deadline = Date.now() + this.busyTimeoutMs;
      for (;;) {
        try {
          db.exec('PRAGMA journal_mode = WAL');
          db.exec(SCHEMA);
          break;
        } catch (error) {
          if (!isBusy(error) || Date.now() >= deadline) throw error;
          sleepSync(10);
        }
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }
}

function isBusy(error: unknown): boolean {
  const e = error as { code?: string; errcode?: number; message?: string } | null;
  return e?.errcode === 5 || e?.errcode === 6 || /database is (locked|busy)/i.test(e?.message ?? '');
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}
