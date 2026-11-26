/**
 * The lane ledger's transitions (.prd/36 v2 §6, .prd/37 §2.2): pure — every rule is a unit test here.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyLedger,
  endEntry,
  enterQueue,
  entriesOfHolder,
  forgetQueue,
  markNotified,
  parseWorkQueueLedger,
  putFirst,
  queuePosition,
  queueViews,
  releaseByHost,
  type WorkQueueHolder,
  type WorkQueueLedger,
} from './ledger';
import { LINE_RECORDS_KEEP } from './line';

const A: WorkQueueHolder = { user: 'U1', channel: 'C1', threadTs: '1.1' };
const B: WorkQueueHolder = { user: 'U2', channel: 'C1', threadTs: '2.2' };
const C: WorkQueueHolder = { user: 'U3', channel: 'C2', threadTs: '3.3' };

function enter(
  ledger: WorkQueueLedger,
  holder: WorkQueueHolder,
  keys: unknown,
  queue = 'qa-dev2',
  now = 1_000,
  mode: 'wait' | 'try' = 'wait',
) {
  return enterQueue(ledger, { queue, keys, holder, mode }, now);
}

describe('enterQueue — a lane needs no configuration', () => {
  it('a lane exists from its first entry; the answer says it is new (a misspelt name would make a second lane)', () => {
    const { ledger, result } = enter(emptyLedger(), A, ['ABC-1'], 'qa-dev2');
    expect(result).toMatchObject({ ok: true, status: 'running', created: true, entry: { queue: 'qa-dev2' } });
    expect(enter(ledger, B, ['ABC-2'], 'qa-dev2').result).toMatchObject({ ok: true, created: false });
  });

  it('reads the v1 `<lane>:<env>` name as the lane — `qa:dev2` and `qa-dev2` are one queue', () => {
    const l = enter(emptyLedger(), A, ['ABC-1'], 'qa:dev2').ledger;
    expect(l.entries[0].queue).toBe('qa-dev2');
    expect(enter(l, B, ['ABC-2'], 'QA-DEV2').result).toMatchObject({ ok: true, status: 'waiting', position: 1 });
  });

  it('refuses a name that is not a short lower-case name', () => {
    expect(enter(emptyLedger(), A, ['ABC-1'], 'qa dev2').result).toMatchObject({ ok: false, code: 'INVALID_QUEUE' });
    expect(enter(emptyLedger(), A, ['ABC-1'], '').result).toMatchObject({ ok: false, code: 'INVALID_QUEUE' });
  });
});

describe('enterQueue — keys (SSOT_2, SSOT_5)', () => {
  it('A1 — refuses keys that are not Jira or GitHub keys, and changes nothing', () => {
    const before = emptyLedger();
    const { ledger, result } = enter(before, A, ['abc', 'ABC-1']);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_KEYS', invalid: ['abc'] });
    expect(ledger).toBe(before);
  });

  it('refuses an empty key list and more than the cap', () => {
    expect(enter(emptyLedger(), A, []).result).toMatchObject({ ok: false, code: 'NO_KEYS' });
    const keys = Array.from({ length: 51 }, (_, i) => `ABC-${i + 1}`);
    expect(enter(emptyLedger(), A, keys).result).toMatchObject({ ok: false, code: 'TOO_MANY_KEYS' });
  });

  it('A4 — a key running or waiting in the same lane refuses the whole entry and names who has it', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    const { ledger, result } = enter(l, C, ['ABC-1', 'abc-2', 'ABC-3']);
    expect(ledger).toBe(l);
    expect(result).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      free: ['ABC-3'],
      conflicts: [
        { key: 'ABC-1', entry: 'wq-1', state: 'running', holder: A },
        { key: 'ABC-2', entry: 'wq-2', state: 'waiting', holder: B },
      ],
    });
    // Drop the claimed keys and enter again with the rest.
    expect(enter(l, C, ['ABC-3']).result).toMatchObject({ ok: true, status: 'waiting', position: 2 });
  });

  it('every key claimed → nothing is left to do (free is empty)', () => {
    const l = enter(emptyLedger(), A, ['ABC-1', 'ABC-2']).ledger;
    expect(enter(l, B, ['ABC-2', 'ABC-1']).result).toMatchObject({ ok: false, code: 'CONFLICT', free: [] });
  });

  it('the same key in another lane is not a conflict', () => {
    const l = enter(emptyLedger(), A, ['2lab-ai/soma-work#5'], 'deploy-dev2').ledger;
    expect(enter(l, B, ['2lab-ai/soma-work#5'], 'qa-dev2').result).toMatchObject({ ok: true, status: 'running' });
  });

  it('a key that ended is free again', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = endEntry(l, { id: 'wq-1', end: 'done', actor: A }, 2_000).ledger;
    expect(enter(l, B, ['ABC-1']).result).toMatchObject({ ok: true, status: 'running' });
  });
});

describe('enterQueue — wait (enter) and try', () => {
  it('A2 — an empty lane starts the entry at once, keys normalized', () => {
    const { ledger, result } = enter(emptyLedger(), A, ['abc-1', '2lab-ai/Soma-Work#12']);
    expect(result).toMatchObject({ ok: true, status: 'running', position: 0, ahead: [] });
    if (!result.ok || result.status === 'busy') throw new Error('unreachable');
    expect(result.entry).toMatchObject({
      id: 'wq-1',
      queue: 'qa-dev2',
      keys: ['ABC-1', '2lab-ai/soma-work#12'],
      holder: A,
      state: 'running',
      enteredAt: 1_000,
      grantedAt: 1_000,
      notifiedAt: 1_000,
    });
    expect(ledger.seq).toBe(1);
  });

  it('A3 — a busy lane lines the entry up behind what runs and waits', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2'], 'qa-dev2', 2_000).ledger;
    const { result } = enter(l, C, ['ABC-3'], 'qa-dev2', 3_000);
    expect(result).toMatchObject({ ok: true, status: 'waiting', position: 2 });
    if (!result.ok || result.status === 'busy') throw new Error('unreachable');
    expect(result.entry.grantedAt).toBeUndefined();
    expect(result.ahead.map((e) => [e.id, e.state])).toEqual([
      ['wq-1', 'running'],
      ['wq-2', 'waiting'],
    ]);
  });

  it('try on a free lane takes it, exactly like enter', () => {
    const { result } = enter(emptyLedger(), A, ['ABC-1'], 'qa-dev2', 1_000, 'try');
    expect(result).toMatchObject({ ok: true, status: 'running', entry: { id: 'wq-1', state: 'running' } });
  });

  it('try on a busy lane adds nothing and says what is ahead — the caller decides whether to wait', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    const { ledger, result } = enter(l, C, ['ABC-3'], 'qa-dev2', 3_000, 'try');
    expect(ledger).toBe(l);
    expect(result).toMatchObject({ ok: true, status: 'busy', queue: 'qa-dev2', position: 2 });
    if (!result.ok || result.status !== 'busy') throw new Error('unreachable');
    expect(result.ahead.map((e) => e.id)).toEqual(['wq-1', 'wq-2']);
  });

  it('try still refuses claimed keys (the conflict is the answer, not a wait)', () => {
    const l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    expect(enter(l, B, ['ABC-1'], 'qa-dev2', 2_000, 'try').result).toMatchObject({ ok: false, code: 'CONFLICT' });
  });

  it('one thread holds one entry per lane', () => {
    const l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    expect(enter(l, A, ['ABC-9']).result).toMatchObject({ ok: false, code: 'ALREADY_IN_QUEUE', entry: { id: 'wq-1' } });
    expect(enter(l, A, ['ABC-9'], 'deploy-dev2').result).toMatchObject({ ok: true });
  });
});

describe('endEntry', () => {
  it('A5 — done hands the lane to the oldest waiting entry, not yet notified, and leaves a record', () => {
    let l = enter(emptyLedger(), A, ['ABC-1'], 'qa-dev2', 1_000).ledger;
    l = enter(l, B, ['ABC-2'], 'qa-dev2', 2_000).ledger;
    l = enter(l, C, ['ABC-3'], 'qa-dev2', 3_000).ledger;
    const { ledger, result } = endEntry(l, { id: 'wq-1', end: 'done', actor: A }, 5_000);
    expect(result).toMatchObject({ ok: true, ended: { id: 'wq-1', end: 'done', endedAt: 5_000, startedAt: 1_000 } });
    if (!result.ok) throw new Error('unreachable');
    expect(result.granted).toMatchObject({ id: 'wq-2', state: 'running', grantedAt: 5_000 });
    expect(result.granted?.notifiedAt).toBeUndefined();
    expect(ledger.entries.map((e) => [e.id, e.state])).toEqual([
      ['wq-2', 'running'],
      ['wq-3', 'waiting'],
    ]);
    expect(ledger.records).toEqual([
      expect.objectContaining({ id: 'wq-1', queue: 'qa-dev2', keys: ['ABC-1'], enteredAt: 1_000, end: 'done' }),
    ]);
  });

  it('cancelling a waiting entry leaves the running one alone', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    const { ledger, result } = endEntry(l, { id: 'wq-2', end: 'cancelled', actor: B, reason: 'not needed' }, 2_000);
    expect(result).toMatchObject({ ok: true, ended: { id: 'wq-2', end: 'cancelled', reason: 'not needed' } });
    if (!result.ok) throw new Error('unreachable');
    expect(result.granted).toBeUndefined();
    expect(result.ended.startedAt).toBeUndefined();
    expect(ledger.entries.map((e) => e.id)).toEqual(['wq-1']);
  });

  it('only the holder thread ends its entry; the host and an admin may end any', () => {
    const l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    expect(endEntry(l, { id: 'wq-1', end: 'done', actor: B }, 2_000).result).toMatchObject({
      ok: false,
      code: 'NOT_HOLDER',
    });
    expect(
      endEntry(l, { id: 'wq-1', end: 'released', actor: 'host', reason: 'holder-idle' }, 2_000).result,
    ).toMatchObject({ ok: true });
    expect(
      endEntry(l, { id: 'wq-1', end: 'released', actor: 'admin', reason: 'admin:U9' }, 2_000).result,
    ).toMatchObject({ ok: true, ended: { end: 'released', reason: 'admin:U9' } });
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

  it('keeps only the most recent records', () => {
    let l = emptyLedger();
    for (let i = 0; i < LINE_RECORDS_KEEP + 5; i++) {
      l = enter(l, A, [`ABC-${i + 1}`], 'qa-dev2', i).ledger;
      l = endEntry(l, { id: `wq-${i + 1}`, end: 'done', actor: A }, i).ledger;
    }
    expect(l.records).toHaveLength(LINE_RECORDS_KEEP);
    expect(l.records[LINE_RECORDS_KEEP - 1].id).toBe(`wq-${LINE_RECORDS_KEEP + 5}`);
  });
});

describe('forgetQueue — an admin forgets an idle lane', () => {
  it("drops the lane's history and leaves every other lane alone; an unpinned lane leaves the views", () => {
    let l = enter(emptyLedger(), A, ['ABC-1'], 'qa-test').ledger;
    l = endEntry(l, { id: 'wq-1', end: 'done', actor: A }, 2).ledger;
    l = enter(l, B, ['ABC-2'], 'qa-dev2').ledger;
    l = endEntry(l, { id: 'wq-2', end: 'done', actor: B }, 3).ledger;
    const { ledger, result } = forgetQueue(l, 'qa-test');
    expect(result).toEqual({ ok: true, removed: 1 });
    expect(ledger.records.map((r) => r.queue)).toEqual(['qa-dev2']);
    expect(queueViews(ledger, []).map((q) => q.id)).toEqual(['qa-dev2']);
    // A pinned lane stays listed, with no history.
    const pinned = forgetQueue(ledger, 'qa-dev2').ledger;
    expect(queueViews(pinned, ['qa-dev2'])).toEqual([expect.objectContaining({ id: 'qa-dev2', recent: [] })]);
  });

  it('refuses a lane with a running or waiting entry (BUSY) or a bad name, and changes nothing', () => {
    const l = enter(emptyLedger(), A, ['ABC-1'], 'qa-test').ledger;
    expect(forgetQueue(l, 'qa-test')).toEqual({ ledger: l, result: { ok: false, code: 'BUSY' } });
    expect(forgetQueue(l, 'qa:test')).toEqual({ ledger: l, result: { ok: false, code: 'BUSY' } });
    expect(forgetQueue(l, '')).toEqual({ ledger: l, result: { ok: false, code: 'INVALID_QUEUE' } });
  });
});

describe('putFirst — an admin lets a waiting entry go first', () => {
  it('moves it ahead of every other waiting entry of its lane; what runs keeps running', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    l = enter(l, C, ['ABC-3']).ledger;
    const { ledger, result } = putFirst(l, 'wq-3');
    expect(result).toEqual({ ok: true });
    expect(ledger.entries.map((e) => [e.id, e.state])).toEqual([
      ['wq-1', 'running'],
      ['wq-3', 'waiting'],
      ['wq-2', 'waiting'],
    ]);
    expect(queuePosition(ledger, ledger.entries[1])).toBe(1);
  });

  it('refuses a running or unknown entry and changes nothing', () => {
    const l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    expect(putFirst(l, 'wq-1')).toEqual({ ledger: l, result: { ok: false, code: 'NOT_WAITING' } });
    expect(putFirst(l, 'wq-7')).toEqual({ ledger: l, result: { ok: false, code: 'UNKNOWN_ENTRY' } });
  });
});

describe('releaseByHost', () => {
  it('ends every named entry and promotes each lane once', () => {
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

  it('positions and holder entries', () => {
    let l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    l = enter(l, B, ['ABC-2']).ledger;
    l = enter(l, B, ['2lab-ai/soma-work#4'], 'deploy-dev2').ledger;
    l = enter(l, C, ['ABC-3']).ledger;
    expect(queuePosition(l, l.entries[0])).toBe(0);
    expect(queuePosition(l, l.entries[3])).toBe(2);
    expect(entriesOfHolder(l, B).map((e) => e.id)).toEqual(['wq-2', 'wq-3']);
  });

  it('views: pinned lanes first (even empty), then every lane in use or with records, by name — one at a time', () => {
    let l = enter(emptyLedger(), A, ['ABC-1'], 'qa-dev2', 1_000).ledger;
    l = enter(l, B, ['ABC-2'], 'qa-dev2', 2_000).ledger;
    l = enter(l, C, ['ABC-3'], 'build-x', 3_000).ledger;
    l = endEntry(l, { id: 'wq-3', end: 'done', actor: C }, 4_000).ledger;
    const views = queueViews(l, ['deploy-dev2', 'qa-dev2']);
    expect(views.map((v) => [v.id, v.kind, v.capacity])).toEqual([
      ['deploy-dev2', 'lane', 1],
      ['qa-dev2', 'lane', 1],
      ['build-x', 'lane', 1],
    ]);
    const qa = views[1];
    expect(qa.running.map((e) => [e.id, e.position])).toEqual([['wq-1', 0]]);
    expect(qa.waiting.map((e) => [e.id, e.position])).toEqual([['wq-2', 1]]);
    expect(views[2].recent.map((r) => [r.id, r.end])).toEqual([['wq-3', 'done']]);
  });
});

describe('parseWorkQueueLedger — the stored ledger', () => {
  it('reads the v1 ledger a host already has: `<lane>:<env>` names, `queued`, `ended`', () => {
    const v1 = {
      version: 1,
      seq: 3,
      entries: [
        {
          id: 'wq-2',
          queue: 'qa:dev2',
          keys: ['ABC-2'],
          holder: A,
          state: 'running',
          enteredAt: 10,
          grantedAt: 20,
          notifiedAt: 20,
        },
        { id: 'wq-3', queue: 'qa:dev2', keys: ['ABC-3'], holder: B, state: 'queued', enteredAt: 15, note: 'n' },
      ],
      ended: [
        {
          id: 'wq-1',
          queue: 'deploy:dev2',
          keys: ['a/b#1'],
          holder: C,
          state: 'running',
          enteredAt: 1,
          grantedAt: 2,
          endedAt: 20,
          end: 'done',
          note: 'deploy',
        },
      ],
    };
    const l = parseWorkQueueLedger(v1);
    expect(l.version).toBe(2);
    expect(l.seq).toBe(3);
    expect(l.entries.map((e) => [e.id, e.queue, e.state])).toEqual([
      ['wq-2', 'qa-dev2', 'running'],
      ['wq-3', 'qa-dev2', 'waiting'],
    ]);
    expect(l.records).toEqual([
      {
        id: 'wq-1',
        queue: 'deploy-dev2',
        keys: ['a/b#1'],
        holder: C,
        label: 'deploy',
        enteredAt: 1,
        startedAt: 2,
        endedAt: 20,
        end: 'done',
      },
    ]);
    // And the next entry continues the line it had.
    expect(enter(l, C, ['ABC-4'], 'qa:dev2').result).toMatchObject({ ok: true, status: 'waiting', position: 2 });
  });

  it('reads a v2 ledger as it is, and throws on anything else (never an empty ledger)', () => {
    const l = enter(emptyLedger(), A, ['ABC-1']).ledger;
    expect(parseWorkQueueLedger(JSON.parse(JSON.stringify(l)))).toEqual(l);
    expect(() => parseWorkQueueLedger({ version: 2, seq: 0, entries: [{ id: 1 }], records: [] })).toThrow();
    expect(() => parseWorkQueueLedger({ version: 9 })).toThrow();
    expect(() => parseWorkQueueLedger(null)).toThrow();
  });
});
