/**
 * The ledger database (.prd/37 §2.3): one SQLite file shared by every MCP process and the host. Every change is one
 * `BEGIN IMMEDIATE` transaction — SQLite's own file locks (released by the OS when a process dies) serialize writers,
 * so there is no lock file, no stale-lock takeover and no backup file to get wrong.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyLedger, enterQueue } from './ledger';
import { WORK_QUEUE_FILE, WorkQueueStore } from './store';

const QUEUES = [{ id: 'qa:dev2', lane: 'qa', env: 'dev2' }];
const A = { user: 'U1', channel: 'C1', threadTs: '1.1' };

let dir: string;
let file: string;
const opened: WorkQueueStore[] = [];

function open(): WorkQueueStore {
  const store = new WorkQueueStore(file);
  opened.push(store);
  return store;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-queue-store-'));
  file = path.join(dir, WORK_QUEUE_FILE);
});

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const enterA = (store: WorkQueueStore, key = 'ABC-1', threadTs = '1.1') =>
  store.mutate((l) => enterQueue(l, { queue: 'qa:dev2', keys: [key], holder: { ...A, threadTs } }, QUEUES, 1_000));

describe('WorkQueueStore', () => {
  it('is a SQLite file in the data dir', () => {
    expect(WORK_QUEUE_FILE).toBe('work-queues.sqlite3');
  });

  it('an empty database reads as an empty ledger with no stamp', () => {
    const store = open();
    expect(store.read()).toEqual(emptyLedger());
    expect(store.stamp()).toBeUndefined();
  });

  it('mutate commits the new ledger and returns the result; the stamp moves on every commit', () => {
    const store = open();
    expect(enterA(store)).toMatchObject({ ok: true, entry: { id: 'wq-1' } });
    const first = store.stamp();
    expect(first).toEqual(expect.any(String));
    enterA(store, 'ABC-2', '2.2');
    expect(store.stamp()).not.toBe(first);
    expect(
      open()
        .read()
        .entries.map((e) => e.id),
    ).toEqual(['wq-1', 'wq-2']);
  });

  it('a refused change commits nothing (the stamp stays)', () => {
    const store = open();
    enterA(store);
    const stamp = store.stamp();
    store.mutate((l) => enterQueue(l, { queue: 'qa:dev2', keys: ['bad'], holder: A }, QUEUES, 1));
    expect(store.stamp()).toBe(stamp);
  });

  it('a throwing change rolls back and leaves the store usable', () => {
    const store = open();
    enterA(store);
    const stamp = store.stamp();
    expect(() =>
      store.mutate(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.stamp()).toBe(stamp);
    expect(enterA(store, 'ABC-2', '2.2')).toMatchObject({ ok: true, entry: { id: 'wq-2' } });
  });

  it('two stores on one file see each other (no lost update)', () => {
    const s1 = open();
    const s2 = open();
    enterA(s1, 'ABC-1');
    expect(enterA(s2, 'ABC-2', '2.2')).toMatchObject({ ok: true, position: 1 });
    expect(s1.read().entries.map((e) => e.id)).toEqual(['wq-1', 'wq-2']);
  });

  it('a stored ledger of the wrong shape is an error, never an empty ledger', () => {
    const store = open();
    enterA(store);
    store.close();
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file);
    db.prepare('UPDATE ledger SET body = ? WHERE id = 1').run(JSON.stringify({ version: 1, seq: 1, entries: [null] }));
    db.close();
    expect(() => open().read()).toThrow(/work-queues/);
  });

  it('writers in separate processes, at once, lose nothing: distinct ids, one running entry', async () => {
    const storeJs = require.resolve('./store');
    const ledgerJs = require.resolve('./ledger');
    const script = `
      const { WorkQueueStore } = require(${JSON.stringify(storeJs)});
      const { enterQueue } = require(${JSON.stringify(ledgerJs)});
      const [file, who, startAt] = process.argv.slice(1);
      while (Date.now() < Number(startAt)) {}
      const store = new WorkQueueStore(file);
      for (let i = 0; i < 15; i++) {
        store.mutate((l) => enterQueue(l, { queue: 'qa:dev2', keys: ['ABC-' + (who * 100 + i + 1)], holder: { user: 'U', channel: 'C' + who, threadTs: who + '.' + i } }, [{ id: 'qa:dev2', lane: 'qa', env: 'dev2' }], Date.now()));
      }
      store.close();
    `;
    const startAt = String(Date.now() + 1_500);
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const kids = [1, 2, 3, 4].map((who) =>
      spawn(process.execPath, ['-e', script, file, String(who), startAt], { stdio: 'inherit' }),
    );
    const codes = await Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r))));
    expect(codes).toEqual([0, 0, 0, 0]);
    const ledger = open().read();
    expect(ledger.entries).toHaveLength(60);
    expect(new Set(ledger.entries.map((e) => e.id)).size).toBe(60);
    expect(ledger.seq).toBe(60);
    expect(ledger.entries.filter((e) => e.state === 'running')).toHaveLength(1);
  }, 60_000);
});
