/**
 * The per-user queue on the shared line (.prd/36 v2 D12, SSOT_5): a request names its work by keys, and a person who
 * sends the same work again — every key already running or waiting in another thread of theirs — is told at once and
 * nothing starts (fast-fail). It keeps a record of what left its line, and shows itself as a line view like a lane.
 */
import type { KeyClaim } from 'somalib/work-queue/line';
import { describe, expect, it } from 'vitest';
import type { UserTaskEntry, UserTaskLedger } from '../ledger';
import { type GateInput, type RunningTask, UNLIMITED, UserTaskQueue, type UserTaskQueueDeps } from '../user-task-queue';

function harness(opts: { ledger?: UserTaskLedger } = {}) {
  const running = new Map<string, RunningTask[]>();
  const limits = new Map<string, number>();
  const started: UserTaskEntry[] = [];
  const resent: Array<Record<string, unknown>> = [];
  const refusals: Array<{ channel: string; threadTs: string; claims: KeyClaim[]; token: string }> = [];
  const clock = { now: 1_000 };
  let seq = 0;
  const deps: UserTaskQueueDeps = {
    store: { load: () => opts.ledger, save: () => undefined },
    limitFor: (user) => limits.get(user) ?? 1,
    runningTasks: (user) => running.get(user) ?? [],
    start: (entry) => {
      started.push(entry);
    },
    interrupt: () => 'stopped',
    resend: (message) => {
      resent.push(message);
    },
    notify: {
      queued: () => undefined,
      started: () => undefined,
      cancelled: () => undefined,
      deferred: () => undefined,
      refused: (thread, claims, token) => {
        refusals.push({ channel: thread.channel, threadTs: thread.threadTs, claims, token });
      },
    },
    now: () => clock.now,
    newId: () => `t${++seq}`,
  };
  return { queue: new UserTaskQueue(deps), running, limits, started, resent, refusals, clock };
}

function input(text: string, over: Partial<GateInput> = {}): GateInput {
  return {
    userId: 'U1',
    sessionKey: 'C1:2.0',
    channel: 'C1',
    threadTs: '2.0',
    text,
    message: { user: 'U1', channel: 'C1', ts: '2.0', text },
    continuation: 'none',
    admitted: false,
    ...over,
  };
}

const taskA: RunningTask = {
  sessionKey: 'C1:1.0',
  channel: 'C1',
  threadTs: '1.0',
  title: 'ABC-1 구현',
  startedAt: 500,
  keys: ['ABC-1', 'acme/shop#7'],
};

describe('UserTaskQueue — the same work sent again fails fast', () => {
  it('every key already running in another thread of the person → refused, told in the thread, nothing starts', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    const result = h.queue.gate(input('ABC-1 다시 해줘 https://github.com/acme/shop/pull/7'));
    expect(result).toMatchObject({
      action: 'same-work',
      claims: [
        { key: 'ABC-1', state: 'running', holder: { channel: 'C1', threadTs: '1.0' } },
        { key: 'acme/shop#7', state: 'running' },
      ],
    });
    expect(h.queue.snapshot().entries).toEqual([]);
    expect(h.refusals).toEqual([
      expect.objectContaining({ channel: 'C1', threadTs: '2.0', claims: expect.any(Array), token: expect.any(String) }),
    ]);
    expect(h.queue.snapshot().records?.slice(-1)[0]).toMatchObject({
      queue: 'user:U1',
      end: 'refused',
      keys: ['ABC-1', 'acme/shop#7'],
      holder: { user: 'U1', channel: 'C1', threadTs: '2.0' },
    });
  });

  it('applies to an admin too (no limit is no licence to run the same work twice)', () => {
    const h = harness();
    h.limits.set('U1', UNLIMITED);
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(input('ABC-1')).action).toBe('same-work');
  });

  it('a key waiting in the person’s line counts as taken too', () => {
    const h = harness();
    h.running.set('U1', [{ ...taskA, keys: [] }]);
    expect(h.queue.gate(input('ABC-9 해줘')).action).toBe('queued');
    expect(h.queue.snapshot().entries[0].keys).toEqual(['ABC-9']);
    const again = h.queue.gate(
      input('ABC-9 해줘 (다시)', { sessionKey: 'C1:3.0', threadTs: '3.0', message: { ts: '3.0', channel: 'C1' } }),
    );
    expect(again).toMatchObject({ action: 'same-work', claims: [{ key: 'ABC-9', state: 'waiting' }] });
  });

  it('some keys free → it goes on as usual (only the whole work sent again is refused)', () => {
    const h = harness();
    h.limits.set('U1', 2);
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(input('ABC-1 and ABC-2'))).toEqual({ action: 'run' });
  });

  it('a request that names no key, a message into the same thread, a cron fire, a host turn: never refused', () => {
    const h = harness();
    h.limits.set('U1', UNLIMITED);
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(input('오늘 리포트 써줘')).action).toBe('run');
    expect(h.queue.gate(input('ABC-1 이어서', { sessionKey: 'C1:1.0', threadTs: '1.0' })).action).toBe('run');
    expect(
      h.queue.gate(input('ABC-1', { message: { channel: 'C1', ts: '', text: 'ABC-1', cron: { jobId: 'j1' } } })).action,
    ).toBe('run');
    expect(h.queue.gate(input('ABC-1', { continuation: 'pass' })).action).toBe('run');
    expect(
      h.queue.gate(input('ABC-1', { message: { channel: 'C1', ts: '9.9', text: 'ABC-1', synthetic: true } })).action,
    ).toBe('run');
  });

  it('그래도 시작: the person sends the refused request on, once — it is gated again, minus the same-work check', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input('ABC-1'));
    const token = h.refusals[0].token;
    expect(h.queue.startSameWork(token, 'U2')).toEqual({ ok: false, reason: 'forbidden' });
    expect(h.queue.startSameWork(token, 'U1')).toEqual({ ok: true });
    expect(h.resent).toHaveLength(1);
    expect((h.resent[0].routeContext as Record<string, unknown>).userTaskSameWorkOk).toBe(true);
    expect(h.queue.startSameWork(token, 'U1')).toEqual({ ok: false, reason: 'not-found' });
    // The resent message passes the same-work check (and is gated on the limit like any other request).
    expect(h.queue.gate(input('ABC-1', { sameWorkOk: true })).action).toBe('queued');
  });

  it('after 그래도 시작 runs the request, a late Slack retry of the original event is still a duplicate (review 2026-11-26)', () => {
    const h = harness();
    h.limits.set('U1', UNLIMITED);
    h.running.set('U1', [taskA]);
    h.queue.gate(input('ABC-1'));
    expect(h.queue.startSameWork(h.refusals[0].token, 'U1')).toEqual({ ok: true });
    expect(h.queue.gate(input('ABC-1', { sameWorkOk: true })).action).toBe('run');
    expect(h.queue.gate(input('ABC-1')).action).toBe('duplicate');
  });

  // #1474 round 10 (astra): an answer to the model's question goes on with its own thread's work — not the same work
  // another thread runs. Only that check: a Slack resend of the answer is still a resend.
  it('#1474 — an answer naming a key another thread runs is not refused; its resend is still a duplicate', () => {
    const h = harness();
    h.limits.set('U1', 1);
    h.running.set('U1', [taskA]);
    expect(h.queue.gate(input('ABC-1 기준으로', { answersQuestion: true })).action).toBe('queued');
    expect(h.refusals).toEqual([]);
    expect(h.queue.gate(input('ABC-1 기준으로', { answersQuestion: true })).action).toBe('duplicate');
    expect(h.queue.snapshot().entries).toHaveLength(1);
  });

  it('a refused request is held for 그래도 시작 30 minutes, then the button says it expired', () => {
    const h = harness();
    h.running.set('U1', [taskA]);
    h.queue.gate(input('ABC-1'));
    h.clock.now += 31 * 60_000;
    expect(h.queue.startSameWork(h.refusals[0].token, 'U1')).toEqual({ ok: false, reason: 'not-found' });
    expect(h.resent).toEqual([]);
  });

  it('a request naming more keys than one entry carries is never refused on the first ones alone', () => {
    const h = harness();
    h.limits.set('U1', UNLIMITED);
    const many = Array.from({ length: 50 }, (_, i) => `ABC-${i + 1}`);
    h.running.set('U1', [{ ...taskA, keys: many }]);
    expect(h.queue.gate(input(`${many.join(' ')} ABC-999`)).action).toBe('run');
  });

  it('the refused record names the keys, never another thread’s session key (a private thread stays unnamed)', () => {
    const h = harness();
    h.running.set('U1', [{ ...taskA, channel: 'D9', sessionKey: 'D9:1.0' }]);
    h.queue.gate(input('ABC-1'));
    const reason = h.queue.snapshot().records?.slice(-1)[0].reason ?? '';
    expect(reason).toBe('same-work');
  });
});

describe('UserTaskQueue — records and the line view (the same shape a lane has)', () => {
  it('records what left the line: started, cancelled, closed', () => {
    const h = harness();
    h.running.set('U1', [{ ...taskA, keys: [] }]);
    h.queue.gate(input('ABC-5 해줘'));
    h.queue.gate(input('ABC-6 해줘', { sessionKey: 'C1:3.0', threadTs: '3.0', message: { ts: '3.0', channel: 'C1' } }));
    h.queue.gate(input('ABC-7 해줘', { sessionKey: 'C1:4.0', threadTs: '4.0', message: { ts: '4.0', channel: 'C1' } }));
    h.clock.now = 2_000;
    h.queue.cancel('t2', 'U1');
    h.queue.dropSession('C1:4.0');
    h.running.set('U1', []);
    h.queue.release('U1');
    const records = h.queue.snapshot().records ?? [];
    expect(records.map((r) => [r.id, r.end, r.reason, r.keys])).toEqual([
      ['t2', 'cancelled', 'person', ['ABC-6']],
      ['t3', 'cancelled', 'closed', ['ABC-7']],
      ['t1', 'started', 'turn', ['ABC-5']],
    ]);
    expect(records[2]).toMatchObject({ queue: 'user:U1', enteredAt: 1_000, startedAt: 2_000 });
  });

  it('lineView: limit, what runs, what waits, what left — newest first', () => {
    const h = harness();
    h.limits.set('U1', 1);
    h.running.set('U1', [taskA]);
    h.queue.gate(input('ABC-5 해줘'));
    h.queue.gate(input('ABC-1', { sessionKey: 'C1:3.0', threadTs: '3.0', message: { ts: '3.0', channel: 'C1' } })); // refused
    const view = h.queue.lineView('U1');
    expect(view).toMatchObject({ id: 'user:U1', kind: 'person', capacity: 1 });
    expect(view.running).toEqual([
      expect.objectContaining({
        id: 'run:C1:1.0',
        state: 'running',
        keys: ['ABC-1', 'acme/shop#7'],
        label: 'ABC-1 구현',
      }),
    ]);
    expect(view.waiting).toEqual([expect.objectContaining({ id: 't1', position: 1, keys: ['ABC-5'] })]);
    expect(view.recent.map((r) => r.end)).toEqual(['refused']);
    h.limits.set('U1', UNLIMITED);
    expect(h.queue.lineView('U1').capacity).toBeNull();
  });

  it('a ledger saved before keys and records reads as it was', () => {
    const old: UserTaskLedger = {
      version: 1,
      entries: [
        {
          id: 'old1',
          userId: 'U1',
          kind: 'request',
          sessionKey: 'C1:5.0',
          channel: 'C1',
          threadTs: '5.0',
          preview: 'x',
          enqueuedAt: 1,
          state: 'waiting',
          message: { channel: 'C1', ts: '5.0' },
        },
      ],
    };
    const h = harness({ ledger: old });
    expect(h.queue.lineView('U1').waiting.map((w) => [w.id, w.keys])).toEqual([['old1', []]]);
  });
});
