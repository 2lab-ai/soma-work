/**
 * The ledger file (.prd/37 §2.3): every change under one cross-process lock, written whole (tmp → rename), a broken
 * file read from its backup and never as an empty ledger.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyLedger, enterQueue } from './ledger';
import { WorkQueueStore } from './store';

const QUEUES = [{ id: 'qa:dev2', lane: 'qa', env: 'dev2' }];
const A = { user: 'U1', channel: 'C1', threadTs: '1.1' };

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-queue-store-'));
  file = path.join(dir, 'work-queues.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const enterA = (store: WorkQueueStore, key = 'ABC-1') =>
  store.mutate((l) => enterQueue(l, { queue: 'qa:dev2', keys: [key], holder: A }, QUEUES, 1_000));

describe('WorkQueueStore', () => {
  it('a missing file reads as an empty ledger', () => {
    expect(new WorkQueueStore(file).read()).toEqual(emptyLedger());
    expect(new WorkQueueStore(file).stamp()).toBeUndefined();
  });

  it('mutate writes the new ledger, returns the result, and frees the lock', () => {
    const store = new WorkQueueStore(file);
    const result = enterA(store);
    expect(result).toMatchObject({ ok: true, entry: { id: 'wq-1' } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries).toHaveLength(1);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(store.stamp()).toEqual(expect.any(String));
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a refused change writes nothing', () => {
    const store = new WorkQueueStore(file);
    store.mutate((l) => enterQueue(l, { queue: 'qa:dev2', keys: ['bad'], holder: A }, QUEUES, 1));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a throwing change frees the lock and leaves the file as it was', () => {
    const store = new WorkQueueStore(file);
    enterA(store);
    const before = fs.readFileSync(file, 'utf8');
    expect(() =>
      store.mutate(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('waits for a lock another process holds, then gives up with LOCK_TIMEOUT', () => {
    const store = new WorkQueueStore(file, { lockTimeoutMs: 60, retryMs: 10 });
    fs.writeFileSync(`${file}.lock`, 'other');
    const started = Date.now();
    expect(() => enterA(store)).toThrow(/LOCK_TIMEOUT/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe('other');
  });

  it('takes over a lock left by a process that died (older than the stale limit)', () => {
    const store = new WorkQueueStore(file, { lockTimeoutMs: 60, retryMs: 10, staleLockMs: 1_000 });
    fs.writeFileSync(`${file}.lock`, '2147483646 1 dead-token');
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(enterA(store)).toMatchObject({ ok: true });
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('every write changes the stamp, even within one clock tick (a rename makes a new file)', () => {
    const store = new WorkQueueStore(file);
    enterA(store, 'ABC-1');
    const first = store.stamp();
    store.mutate((l) =>
      enterQueue(l, { queue: 'qa:dev2', keys: ['ABC-2'], holder: { ...A, threadTs: '2.2' } }, QUEUES, 2),
    );
    expect(store.stamp()).not.toBe(first);
  });

  it('a lock whose holder process is alive is never taken over, however old', () => {
    const store = new WorkQueueStore(file, { lockTimeoutMs: 60, retryMs: 10, staleLockMs: 1_000 });
    fs.writeFileSync(`${file}.lock`, `${process.pid} 1 live-token`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(() => enterA(store)).toThrow(/LOCK_TIMEOUT/);
    expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe(`${process.pid} 1 live-token`);
  });

  it('unlock removes only its own lock', () => {
    const store = new WorkQueueStore(file);
    expect(() =>
      store.mutate((l) => {
        // Another process's lock now sits where ours was (it was taken over while we ran).
        fs.writeFileSync(`${file}.lock`, '999999 1 someone-else');
        return { ledger: l, result: undefined };
      }),
    ).not.toThrow();
    expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe('999999 1 someone-else');
  });

  it('a takeover that keeps failing still stops at the deadline', () => {
    const store = new WorkQueueStore(file, { lockTimeoutMs: 50, retryMs: 5, staleLockMs: 1 });
    fs.mkdirSync(`${file}.lock`); // not a file: it cannot be read or renamed as a stale lock file
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(() => enterA(store)).toThrow(/LOCK_TIMEOUT/);
    fs.rmdirSync(`${file}.lock`);
  });

  it('two stores on one file see each other (no lost update)', () => {
    const s1 = new WorkQueueStore(file);
    const s2 = new WorkQueueStore(file);
    enterA(s1, 'ABC-1');
    const second = s2.mutate((l) =>
      enterQueue(l, { queue: 'qa:dev2', keys: ['ABC-2'], holder: { ...A, threadTs: '2.2' } }, QUEUES, 2),
    );
    expect(second).toMatchObject({ ok: true, position: 1 });
    expect(s1.read().entries.map((e) => e.id)).toEqual(['wq-1', 'wq-2']);
  });

  it('a broken file is read from its backup; with no backup it throws instead of reading empty', () => {
    const store = new WorkQueueStore(file);
    enterA(store, 'ABC-1');
    enterA(new WorkQueueStore(file), 'ABC-1'); // refused (already in queue) — no write, backup stays absent
    store.mutate((l) =>
      enterQueue(l, { queue: 'qa:dev2', keys: ['ABC-2'], holder: { ...A, threadTs: '2.2' } }, QUEUES, 2),
    );
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
    fs.writeFileSync(file, '{ torn');
    expect(store.read().entries.map((e) => e.id)).toEqual(['wq-1']);
    fs.rmSync(`${file}.bak`);
    expect(() => store.read()).toThrow(/work-queues/);
  });

  it('a change on a broken file with a backup starts from the backup', () => {
    const store = new WorkQueueStore(file);
    enterA(store, 'ABC-1');
    store.mutate((l) =>
      enterQueue(l, { queue: 'qa:dev2', keys: ['ABC-2'], holder: { ...A, threadTs: '2.2' } }, QUEUES, 2),
    );
    fs.writeFileSync(file, 'null');
    const r = store.mutate((l) =>
      enterQueue(l, { queue: 'qa:dev2', keys: ['ABC-3'], holder: { ...A, threadTs: '3.3' } }, QUEUES, 3),
    );
    expect(r).toMatchObject({ ok: true, entry: { id: 'wq-2' } });
  });
});

describe('WorkQueueStore — review R2', () => {
  it('a live file with a malformed record is broken: the backup is read instead', () => {
    const store = new WorkQueueStore(file);
    enterA(store, 'ABC-1');
    store.mutate((l) =>
      enterQueue(l, { queue: 'qa:dev2', keys: ['ABC-2'], holder: { ...A, threadTs: '2.2' } }, QUEUES, 2),
    );
    fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 2, entries: [null], ended: [] }));
    const warnings: string[] = [];
    const warned = new WorkQueueStore(file, { warn: (m) => warnings.push(m) });
    expect(warned.read().entries.map((e) => e.id)).toEqual(['wq-1']);
    expect(warnings.join(' ')).toMatch(/backup/);
  });

  it('a stale lock is not taken while another process recovers it (the reclaim guard)', () => {
    const store = new WorkQueueStore(file, { lockTimeoutMs: 60, retryMs: 10, staleLockMs: 1_000 });
    fs.writeFileSync(`${file}.lock`, '2147483646 1 dead-token');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    fs.writeFileSync(`${file}.lock.reclaim`, `${process.pid} ${Date.now()} other-recoverer`);
    expect(() => enterA(store)).toThrow(/LOCK_TIMEOUT/);
    expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe('2147483646 1 dead-token');
  });

  it('writers in separate processes, overlapping, lose nothing: distinct ids, one running entry per queue', () => {
    const storeJs = require.resolve('./store');
    const ledgerJs = require.resolve('./ledger');
    const script = `
      const { WorkQueueStore } = require(${JSON.stringify(storeJs)});
      const { enterQueue } = require(${JSON.stringify(ledgerJs)});
      const [file, who] = process.argv.slice(1);
      const store = new WorkQueueStore(file, { lockTimeoutMs: 20000, retryMs: 2 });
      for (let i = 0; i < 15; i++) {
        store.mutate((l) => enterQueue(l, { queue: 'qa:dev2', keys: ['ABC-' + (who * 100 + i + 1)], holder: { user: 'U', channel: 'C' + who, threadTs: who + '.' + i } }, [{ id: 'qa:dev2', lane: 'qa', env: 'dev2' }], Date.now()));
      }
    `;
    const kids = [1, 2, 3, 4].map((who) =>
      require('node:child_process').spawn(process.execPath, ['-e', script, file, String(who)], { stdio: 'inherit' }),
    );
    return Promise.all(kids.map((k: any) => new Promise((r) => k.on('exit', r)))).then((codes) => {
      expect(codes).toEqual([0, 0, 0, 0]);
      const ledger = new WorkQueueStore(file).read();
      expect(ledger.entries).toHaveLength(60);
      expect(new Set(ledger.entries.map((e) => e.id)).size).toBe(60);
      expect(ledger.seq).toBe(60);
      expect(ledger.entries.filter((e) => e.state === 'running')).toHaveLength(1);
    });
  }, 60_000);
});
