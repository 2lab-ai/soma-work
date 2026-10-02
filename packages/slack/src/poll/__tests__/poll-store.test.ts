import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PollStore } from '../poll-store';
import type { PollRecord } from '../poll-types';

function record(overrides: Partial<PollRecord> = {}): PollRecord {
  return {
    id: 'poll_1',
    channel: 'C1',
    threadTs: '100.1',
    messageTs: '100.2',
    creatorId: 'UCREATOR',
    title: '점심',
    options: ['김치찌개', '된장찌개'],
    votes: {},
    voteActionTs: {},
    closesAt: 2_000_000,
    status: 'open',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('PollStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-store-'));
    file = path.join(dir, 'polls.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists inserts and updates so a fresh store (bot restart) sees the same votes', () => {
    const store = new PollStore(file);
    store.load();
    store.insert(record());
    store.update('poll_1', (p) => {
      p.votes.UA = 1;
      p.voteActionTs.UA = '101.5';
    });

    const reloaded = new PollStore(file);
    reloaded.load();
    const p = reloaded.get('poll_1');
    expect(p?.status).toBe('open');
    expect(p?.messageTs).toBe('100.2');
    expect(p?.votes).toEqual({ UA: 1 });
    expect(p?.voteActionTs).toEqual({ UA: '101.5' });
  });

  it('findOpenInThread returns only an open poll of that exact thread', () => {
    const store = new PollStore(file);
    store.load();
    store.insert(record({ id: 'a', status: 'closed' }));
    store.insert(record({ id: 'b', status: 'open', threadTs: '999.9' }));
    store.insert(record({ id: 'd', status: 'canceled' }));
    expect(store.findOpenInThread('C1', '100.1')).toBeUndefined();
    store.insert(record({ id: 'c', status: 'open' }));
    expect(store.findOpenInThread('C1', '100.1')?.id).toBe('c');
  });

  it('findByInvocation finds a poll by the tool invocation id', () => {
    const store = new PollStore(file);
    store.load();
    store.insert(record({ id: 'x', invocationId: 'toolu_1' }));
    expect(store.findByInvocation('toolu_1')?.id).toBe('x');
    expect(store.findByInvocation('toolu_2')).toBeUndefined();
  });

  it('get returns a copy: mutating it does not change stored state without update()', () => {
    const store = new PollStore(file);
    store.load();
    store.insert(record());
    const copy = store.get('poll_1');
    if (copy) copy.votes.UX = 0;
    expect(store.get('poll_1')?.votes).toEqual({});
  });

  it('starts empty when the file is missing and ignores malformed entries', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, polls: { bad: { id: 'bad' }, good: record({ id: 'good' }) } }));
    const store = new PollStore(file);
    store.load();
    expect(store.get('bad')).toBeUndefined();
    expect(store.get('good')?.id).toBe('good');

    const empty = new PollStore(path.join(dir, 'missing.json'));
    empty.load();
    expect(empty.all()).toEqual([]);
  });

  it('update on an unknown id throws (callers must check existence first)', () => {
    const store = new PollStore(file);
    store.load();
    expect(() => store.update('nope', () => {})).toThrow();
  });
});
