/**
 * The work-queue ledger's transitions (.prd/36 §6 A1–A5, .prd/37 §2.2): pure — every rule is a unit test here.
 */
import { describe, expect, it } from 'vitest';
import type { WorkQueueDef } from './config';
import {
  ENDED_KEEP,
  emptyLedger,
  endEntry,
  enterQueue,
  entriesOfHolder,
  markNotified,
  queuePosition,
  queueViews,
  releaseByHost,
  type WorkQueueHolder,
  type WorkQueueLedger,
} from './ledger';

const QUEUES: WorkQueueDef[] = [
  { id: 'qa:dev2', lane: 'qa', env: 'dev2' },
  { id: 'deploy:dev2', lane: 'deploy', env: 'dev2' },
];
const A: WorkQueueHolder = { user: 'U1', channel: 'C1', threadTs: '1.1' };
const B: WorkQueueHolder = { user: 'U2', channel: 'C1', threadTs: '2.2' };
const C: WorkQueueHolder = { user: 'U3', channel: 'C2', threadTs: '3.3' };

function enter(ledger: WorkQueueLedger, holder: WorkQueueHolder, keys: unknown, queue = 'qa:dev2', now = 1_000) {
  return enterQueue(ledger, { queue, keys, holder }, QUEUES, now);
}

describe('enterQueue', () => {
  it('A1 — refuses keys that are not Jira or GitHub keys, and changes nothing', () => {
    const before = emptyLedger();
    const { ledger, result } = enter(before, A, ['abc', 'ABC-1']);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_KEYS', invalid: ['abc'] });
    expect(ledger).toBe(before);
  });

  it('refuses an empty key list and an unknown queue (naming the configured ones)', () => {
    expect(enter(emptyLedger(), A, []).result).toMatchObject({ ok: false, code: 'NO_KEYS' });
    expect(enter(emptyLedger(), A, ['ABC-1'], 'qa:stage9').result).toMatchObject({
      ok: false,
      code: 'UNKNOWN_QUEUE',
      queues: ['qa:dev2', 'deploy:dev2'],
    });
  });

  it('reads the queue name as the config does — `deploy:deploy/dev2` is `deploy:dev2`', () => {
    const { result } = enter(emptyLedger(), A, ['ABC-1'], 'deploy:deploy/DEV2');
    expect(result).toMatchObject({ ok: true, entry: { queue: 'deploy:dev2' } });
  });

  it('refuses more than the key cap', () => {
    const keys = Array.from({ length: 51 }, (_, i) => `PTN-${i + 1}`);
    expect(enter(emptyLedger(), A, keys).result).toMatchObject({ ok: false, code: 'TOO_MANY_KEYS' });
  });

  it('A2 — an empty queue starts the entry at once, keys normalized', () => {
    const { ledger, result } = enter(emptyLedger(), A, ['abc-1', '2lab-ai/Soma-Work#12']);
    expect(result).toMatchObject({ ok: true, position: 0, ahead: [] });
    if (!result.ok) throw new Error('unreachable');
    expect(result.entry).toMatchObject({
      id: 'wq-1',
      queue: 'qa:dev2',
      keys: ['ABC-1', '2lab-ai/soma-work#12'],
      holder: A,
      state: 'running',
      enteredAt: 1_000,
      grantedAt: 1_000,
      notifiedAt: 1_000,
    });
    expect(ledger.seq).toBe(1);
    expect(ledger.entries).toHaveLength(1);
  });

  it('A3 — a busy queue lines the entry up behind what runs and waits', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2'], 'qa:dev2', 2_000).ledger;
    const { result } = enter(l, C, ['ABC-3'], 'qa:dev2', 3_000);
    expect(result).toMatchObject({ ok: true, position: 2 });
    if (!result.ok) throw new Error('unreachable');
    expect(result.entry.state).toBe('queued');
    expect(result.entry.grantedAt).toBeUndefined();
    expect(result.ahead.map((e) => [e.id, e.state])).toEqual([
      ['wq-1', 'running'],
      ['wq-2', 'queued'],
    ]);
  });

  it('A4 — a key already running or waiting in the same queue refuses the whole entry and names the owner', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    const { ledger, result } = enter(l, C, ['ABC-1', 'abc-2', 'ABC-3']);
    expect(ledger).toBe(l);
    expect(result).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      conflicts: [
        { key: 'ABC-1', entry: 'wq-1', state: 'running', holder: A },
        { key: 'ABC-2', entry: 'wq-2', state: 'queued', holder: B },
      ],
    });
    // Drop the taken keys and enter again with the rest.
    expect(enter(l, C, ['ABC-3']).result).toMatchObject({ ok: true, position: 2 });
  });

  it('the same key in another queue is not a conflict (QA and deploy are separate lanes)', () => {
    const l = enter(emptyLedger(), A, ['2lab-ai/soma-work#5'], 'deploy:dev2').ledger;
    expect(enter(l, B, ['2lab-ai/soma-work#5'], 'qa:dev2').result).toMatchObject({ ok: true, position: 0 });
  });

  it('one thread holds one entry per queue', () => {
    const l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    expect(enter(l, A, ['ABC-9']).result).toMatchObject({
      ok: false,
      code: 'ALREADY_IN_QUEUE',
      entry: { id: 'wq-1' },
    });
    expect(enter(l, A, ['ABC-9'], 'deploy:dev2').result).toMatchObject({ ok: true });
  });

  it('a key that ended is free again', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = endEntry(l, { id: 'wq-1', end: 'done', actor: A }, 2_000).ledger;
    expect(enter(l, B, ['ABC-1']).result).toMatchObject({ ok: true, position: 0 });
  });
});

describe('endEntry', () => {
  it('A5 — done hands the queue to the oldest waiting entry, not yet notified', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2'], 'qa:dev2', 2_000).ledger;
    l = enter(l, C, ['ABC-3'], 'qa:dev2', 3_000).ledger;
    const { ledger, result } = endEntry(l, { id: 'wq-1', end: 'done', actor: A }, 5_000);
    expect(result).toMatchObject({ ok: true, ended: { id: 'wq-1', end: 'done', endedAt: 5_000 } });
    if (!result.ok) throw new Error('unreachable');
    expect(result.granted).toMatchObject({ id: 'wq-2', state: 'running', grantedAt: 5_000 });
    expect(result.granted?.notifiedAt).toBeUndefined();
    expect(ledger.entries.map((e) => [e.id, e.state])).toEqual([
      ['wq-2', 'running'],
      ['wq-3', 'queued'],
    ]);
    expect(ledger.ended.map((e) => e.id)).toEqual(['wq-1']);
  });

  it('cancelling a waiting entry leaves the running one alone', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    const { ledger, result } = endEntry(l, { id: 'wq-2', end: 'cancelled', actor: B, reason: 'not needed' }, 2_000);
    expect(result).toMatchObject({ ok: true, ended: { id: 'wq-2', end: 'cancelled', reason: 'not needed' } });
    if (!result.ok) throw new Error('unreachable');
    expect(result.granted).toBeUndefined();
    expect(ledger.entries.map((e) => e.id)).toEqual(['wq-1']);
  });

  it('only the holder thread ends its entry; the host may end any', () => {
    const l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    expect(endEntry(l, { id: 'wq-1', end: 'done', actor: B }, 2_000).result).toMatchObject({
      ok: false,
      code: 'NOT_HOLDER',
    });
    expect(
      endEntry(l, { id: 'wq-1', end: 'released', actor: 'host', reason: 'holder-idle' }, 2_000).result,
    ).toMatchObject({
      ok: true,
    });
  });

  it('an entry that already ended says how; an unknown one says so', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = endEntry(l, { id: 'wq-1', end: 'released', actor: 'host', reason: 'holder-idle' }, 2_000).ledger;
    expect(endEntry(l, { id: 'wq-1', end: 'done', actor: A }, 3_000).result).toMatchObject({
      ok: false,
      code: 'ALREADY_ENDED',
      ended: { end: 'released', reason: 'holder-idle' },
    });
    expect(endEntry(l, { id: 'wq-9', end: 'done', actor: A }, 3_000).result).toMatchObject({
      ok: false,
      code: 'UNKNOWN_ENTRY',
    });
  });

  it('keeps only the most recent ended entries', () => {
    let l = emptyLedger();
    for (let i = 0; i < ENDED_KEEP + 5; i++) {
      l = enter(l, A, [`PTN-${i + 1}`], 'qa:dev2', i).ledger;
      l = endEntry(l, { id: `wq-${i + 1}`, end: 'done', actor: A }, i).ledger;
    }
    expect(l.ended).toHaveLength(ENDED_KEEP);
    expect(l.ended[ENDED_KEEP - 1].id).toBe(`wq-${ENDED_KEEP + 5}`);
  });
});

describe('releaseByHost', () => {
  it('ends every named entry and promotes each queue once', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    l = enter(l, C, ['ABC-3']).ledger;
    const { ledger, ended, granted } = releaseByHost(
      l,
      [
        { id: 'wq-1', reason: 'holder-idle' },
        { id: 'wq-2', reason: 'holder-gone' },
      ],
      9_000,
    );
    expect(ended.map((e) => [e.id, e.end, e.reason])).toEqual([
      ['wq-1', 'released', 'holder-idle'],
      ['wq-2', 'released', 'holder-gone'],
    ]);
    expect(granted.map((e) => e.id)).toEqual(['wq-3']);
    expect(ledger.entries).toEqual([expect.objectContaining({ id: 'wq-3', state: 'running', grantedAt: 9_000 })]);
  });

  it('nothing to release keeps the same ledger', () => {
    const l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    expect(releaseByHost(l, [{ id: 'wq-7', reason: 'x' }], 1).ledger).toBe(l);
  });
});

describe('reading the ledger', () => {
  it('markNotified stamps a granted entry once', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    l = endEntry(l, { id: 'wq-1', end: 'done', actor: A }, 5_000).ledger;
    const marked = markNotified(l, 'wq-2', 6_000);
    expect(marked.entries[0].notifiedAt).toBe(6_000);
    expect(markNotified(marked, 'wq-2', 7_000)).toBe(marked);
  });

  it('positions, holder entries and queue views', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    l = enter(l, B, ['2lab-ai/soma-work#4'], 'deploy:dev2').ledger;
    l = enter(l, C, ['ABC-3']).ledger;
    expect(queuePosition(l, l.entries[0])).toBe(0);
    expect(queuePosition(l, l.entries[3])).toBe(2);
    expect(entriesOfHolder(l, B).map((e) => e.id)).toEqual(['wq-2', 'wq-3']);
    const views = queueViews(l, QUEUES);
    expect(views.map((v) => [v.queue, v.running?.id, v.queued.map((e) => e.id)])).toEqual([
      ['qa:dev2', 'wq-1', ['wq-2', 'wq-4']],
      ['deploy:dev2', 'wq-3', []],
    ]);
  });
});
