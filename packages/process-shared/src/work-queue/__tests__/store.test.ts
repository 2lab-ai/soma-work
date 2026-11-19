/**
 * The ledger file (.prd/37 §2.3): every change under one cross-process lock, written whole (tmp → rename), a broken
 * file read from its backup and never as an empty ledger.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyLedger, enterQueue } from '../ledger';
import { WorkQueueStore } from '../store';

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
    expect(new WorkQueueStore(file).mtimeMs()).toBeUndefined();
  });

  it('mutate writes the new ledger, returns the result, and frees the lock', () => {
    const store = new WorkQueueStore(file);
    const result = enterA(store);
    expect(result).toMatchObject({ ok: true, entry: { id: 'wq-1' } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries).toHaveLength(1);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(store.mtimeMs()).toBeGreaterThan(0);
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
    fs.writeFileSync(`${file}.lock`, 'dead');
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(enterA(store)).toMatchObject({ ok: true });
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
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
