import { describe, expect, it, vi } from 'vitest';
import {
  type DispatchAuthContext,
  type DispatcherNotice,
  type DispatchOutcome,
  type DispatchRequest,
  FollowupDispatcher,
  type FollowupDispatcherDeps,
  type FollowupQueuePort,
  type InterruptAuthContext,
  type SendNowResult,
} from '../followup-dispatcher';
import { type FollowupItem, FollowupQueue } from '../followup-queue';
import type { MessageEvent } from '../pipeline/types';

const SESSION = 'C1:1700.000000';
const AUTHOR = 'U-AUTHOR';
const CLICKER = 'U-CLICKER';

function event(over: Partial<MessageEvent> = {}): MessageEvent {
  return { user: AUTHOR, channel: 'C1', ts: '1700.000100', text: '진행중인거 알려줘?', ...over };
}

/** Flush every pending microtask — the authorization/interrupt hooks are async. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function enqueue(queue: FollowupQueue, message: MessageEvent): FollowupItem {
  const result = queue.enqueue(SESSION, message);
  if (result.status !== 'queued') throw new Error(`enqueue failed: ${result.status}`);
  return result.item;
}

/**
 * Explicit port over the real `FollowupQueue` — every method delegates, so
 * these tests run against the real FIFO/CAS/turn-generation state machine
 * rather than a mock of it. `extras` exists only so a test can inject a
 * failing store on one specific operation.
 */
function portOf(queue: FollowupQueue, extras: Partial<FollowupQueuePort> = {}): FollowupQueuePort {
  return {
    claimNext: (s) => queue.claimNext(s),
    reserve: (s, i, e, t) => queue.reserve(s, i, e, t),
    promote: (s, i, e) => queue.promote(s, i, e),
    markDispatched: (s, i, e) => queue.markDispatched(s, i, e),
    settle: (s, i, e, o, r) => queue.settle(s, i, e, o, r),
    rollback: (s, i, e, r) => queue.rollback(s, i, e, r),
    get: (s, i) => queue.get(s, i),
    list: (s) => queue.list(s),
    freezeReason: (s) => queue.freezeReason(s),
    beginTurn: (s) => queue.beginTurn(s),
    getTurnEpoch: (s) => queue.getTurnEpoch(s),
    markInterrupted: (s, i, e, r) => queue.markInterrupted(s, i, e, r),
    steer: (s, i, e, u) => queue.steer(s, i, e, u),
    markConsumed: (s, u) => queue.markConsumed(s, u),
    unsteer: (s, u, r) => queue.unsteer(s, u, r),
    unsteerAll: (s, r) => queue.unsteerAll(s, r),
    ...extras,
  };
}

interface PendingRun {
  request: DispatchRequest;
  settle: (outcome: DispatchOutcome) => void;
}

/**
 * Click a rendered `Send now` control the way the host does: with the payload
 * the dispatcher handed out at render time (item CAS epoch + turn epoch).
 */
function click(h: { dispatcher: FollowupDispatcher }, itemId: string, clicker = CLICKER): Promise<SendNowResult> {
  const payload = h.dispatcher.controlPayload(SESSION, itemId);
  if (!payload) throw new Error(`no control payload for ${itemId}`);
  return h.dispatcher.sendNow(SESSION, payload.itemId, payload.itemEpoch, clicker, payload.turnEpoch);
}

function harness(overrides: Partial<FollowupDispatcherDeps> = {}) {
  const queue = new FollowupQueue();
  // Spy that still performs the real `dispatched → uncertain` transition.
  const markInterrupted = vi.fn((sessionKey: string, itemId: string, expectedEpoch: number, reason: string) =>
    queue.markInterrupted(sessionKey, itemId, expectedEpoch, reason),
  );
  const port = portOf(queue, { markInterrupted });
  const pending: PendingRun[] = [];
  const notices: DispatcherNotice[] = [];
  const order: string[] = [];

  // A real dispatch resolves only after the whole run is torn down. The test
  // holds that promise so "the abort was signalled" and "the run is finished"
  // stay two distinct instants (`stream-executor.ts:3702` removes the
  // controller BEFORE the cleanup awaits at `:3726` — an absent coordinator
  // slot is not a finished run).
  const dispatch = vi.fn(
    (request: DispatchRequest) =>
      new Promise<DispatchOutcome>((resolve) => {
        order.push('dispatch');
        pending.push({ request, settle: resolve });
      }),
  );
  const interrupt = vi.fn(async () => {
    order.push('interrupt');
  });
  const invalidateSurface = vi.fn(() => {
    order.push('invalidate');
  });
  const authorizeInterrupt = vi.fn(async (_context: InterruptAuthContext) => ({ allowed: true }) as const);
  const authorizeDispatch = vi.fn(async (_context: DispatchAuthContext) => ({ allowed: true }) as const);

  const deps: FollowupDispatcherDeps = {
    queue: port,
    dispatch,
    interrupt,
    invalidateSurface,
    authorizeInterrupt,
    authorizeDispatch,
    notify: (notice) => notices.push(notice),
    ...overrides,
  };
  const dispatcher = new FollowupDispatcher(deps);

  // Expose the hooks that were actually INJECTED, not the defaults: otherwise
  // a test that overrides one asserts against an object nobody ever calls.
  return {
    queue,
    dispatcher,
    dispatch: deps.dispatch as typeof dispatch,
    interrupt: deps.interrupt as typeof interrupt,
    invalidateSurface: deps.invalidateSurface as typeof invalidateSurface,
    authorizeInterrupt: deps.authorizeInterrupt as typeof authorizeInterrupt,
    authorizeDispatch: deps.authorizeDispatch as typeof authorizeDispatch,
    markInterrupted,
    pending,
    notices,
    order,
  };
}

describe('FollowupDispatcher busy fence', () => {
  it('reserves the session synchronously — before the dispatch promise settles', () => {
    const h = harness();

    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0', text: 'first' }));

    expect(start.status).toBe('dispatched');
    expect(h.dispatcher.isBusy(SESSION)).toBe(true);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a second idle input while the first run is still in flight', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));

    const second = h.dispatcher.runInitial(SESSION, event({ ts: '1.1' }));

    expect(second.status).toBe('busy');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('stays busy through teardown and only clears once the run promise settles', async () => {
    const h = harness();
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');

    h.pending[0].settle({ result: 'safe' });
    expect(h.dispatcher.isBusy(SESSION)).toBe(true); // promise resolved, continuation not run yet
    const report = await start.run.settled;

    expect(report.outcome).toEqual({ result: 'safe' });
    expect(report.canDrain).toBe(true);
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
  });

  it('treats a rejected dispatch promise as a confirmed error, not a success', async () => {
    const h = harness({ dispatch: vi.fn(() => Promise.reject(new Error('executor blew up'))) });
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');

    const report = await start.run.settled;

    expect(report.outcome).toEqual({ result: 'error', reason: 'executor blew up' });
    expect(report.canDrain).toBe(false);
  });
});

describe('FollowupDispatcher turn generation', () => {
  it('takes the turn epoch from the queue and bumps it exactly once per dispatch', () => {
    const queue = new FollowupQueue();
    let turnEpoch = 7;
    const beginTurn = vi.fn(() => ++turnEpoch);
    const getTurnEpoch = vi.fn(() => turnEpoch);
    const h = harness({ queue: portOf(queue, { beginTurn, getTurnEpoch }) });

    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');

    expect(beginTurn).toHaveBeenCalledTimes(1);
    expect(beginTurn).toHaveBeenCalledWith(SESSION);
    expect(start.run.turnEpoch).toBe(8);
    expect((h.dispatch.mock.calls[0][0] as DispatchRequest).turnEpoch).toBe(8);
    expect(h.dispatcher.snapshot(SESSION).turnEpoch).toBe(8);
  });

  it('hands the host a control payload carrying both the item CAS epoch and the turn epoch', () => {
    const queue = new FollowupQueue();
    let turnEpoch = 3;
    const h = harness({ queue: portOf(queue, { beginTurn: () => ++turnEpoch, getTurnEpoch: () => turnEpoch }) });
    const item = enqueue(queue, event({ ts: '1.1' }));

    expect(h.dispatcher.controlPayload(SESSION, item.id)).toEqual({
      sessionKey: SESSION,
      itemId: item.id,
      itemEpoch: item.epoch,
      turnEpoch: 3,
    });
    expect(h.dispatcher.controlPayload(SESSION, 'nope')).toBeUndefined();
  });

  it('rejects a click rendered under an older turn before touching the item', async () => {
    const queue = new FollowupQueue();
    let turnEpoch = 3;
    const h = harness({ queue: portOf(queue, { beginTurn: () => ++turnEpoch, getTurnEpoch: () => turnEpoch }) });
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' })); // turnEpoch 3 → 4
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await h.dispatcher.sendNow(SESSION, item.id, item.epoch, CLICKER, 3);

    expect(result).toEqual({ status: 'rejected', reason: 'stale-turn-epoch', detail: expect.any(String) });
    expect(h.authorizeInterrupt).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(queue.get(SESSION, item.id)?.epoch).toBe(item.epoch);
  });
});

describe('FollowupDispatcher auto drain', () => {
  it('claims one item synchronously so a message arriving in the same tick sees busy', async () => {
    const h = harness();
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const draining = h.dispatcher.drainNext(SESSION);

    expect(h.dispatcher.isBusy(SESSION)).toBe(true);
    expect(h.queue.get(SESSION, item.id)?.state).toBe('claimed');
    expect(h.dispatcher.runInitial(SESSION, event({ ts: '1.2' })).status).toBe('busy');

    const result = await draining;
    expect(result.status).toBe('dispatched');
    expect(h.queue.get(SESSION, item.id)?.state).toBe('dispatched');
  });

  it('dispatches the original author/text/files and never mutates the stored item', async () => {
    const h = harness();
    const files = [
      {
        id: 'F1',
        name: 'a.png',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'u',
        url_private_download: 'd',
        size: 1,
      },
    ];
    const item = enqueue(h.queue, event({ ts: '1.1', user: AUTHOR, text: '원문', files }));

    await h.dispatcher.drainNext(SESSION);

    const request = h.dispatch.mock.calls[0][0] as DispatchRequest;
    expect(request.message.user).toBe(AUTHOR);
    expect(request.message.text).toBe('원문');
    expect(request.message.files).toEqual(files);
    expect(request.item?.id).toBe(item.id);
    expect(request.kind).toBe('drain');

    // The runner gets a clone: scribbling on it cannot reach queue state.
    request.message.text = 'mutated';
    request.message.files?.splice(0, 1);
    expect(h.queue.get(SESSION, item.id)?.message.text).toBe('원문');
    expect(h.queue.get(SESSION, item.id)?.message.files).toEqual(files);
  });

  it('rolls a dispatch-time denial back to the same seq as queued, with no dispatch', async () => {
    const h = harness({
      authorizeDispatch: vi.fn(async () => ({ allowed: false, reason: 'no exec permission' }) as const),
    });
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const result = await h.dispatcher.drainNext(SESSION);

    expect(result).toEqual({ status: 'denied', itemId: item.id, detail: 'no exec permission' });
    expect(h.dispatch).not.toHaveBeenCalled();
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.seq).toBe(item.seq);
    expect(stored?.stateReason).toBe('no exec permission');
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
  });

  it('stops draining after a denial instead of spinning, until an explicit trigger clears it', async () => {
    const allow = { allowed: true } as const;
    const deny = { allowed: false, reason: 'no exec permission' } as const;
    const authorizeDispatch = vi.fn(async () => deny as typeof allow | typeof deny);
    const h = harness({ authorizeDispatch });
    enqueue(h.queue, event({ ts: '1.1' }));

    await h.dispatcher.drainNext(SESSION);
    const second = await h.dispatcher.drainNext(SESSION);

    expect(second).toEqual({ status: 'idle', reason: 'halted', detail: 'no exec permission' });
    expect(h.dispatcher.shouldYield(SESSION)).toBe(false);
    expect(authorizeDispatch).toHaveBeenCalledTimes(1); // no automatic retry

    authorizeDispatch.mockResolvedValue(allow);
    h.dispatcher.clearDrainHalt(SESSION, 'permission-change');
    const third = await h.dispatcher.drainNext(SESSION);

    expect(third.status).toBe('dispatched');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('yields to a queued follow-up before autogoal, and stops yielding when the queue is empty', async () => {
    const h = harness();
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    expect(h.dispatcher.shouldYield(SESSION)).toBe(true);

    const drained = await h.dispatcher.drainNext(SESSION);
    if (drained.status !== 'dispatched') throw new Error('expected dispatch');
    expect(h.dispatcher.shouldYield(SESSION)).toBe(false);

    h.pending[0].settle({ result: 'safe' });
    await drained.run.settled;

    expect(h.queue.get(SESSION, item.id)?.state).toBe('resolved');
    expect(h.dispatcher.shouldYield(SESSION)).toBe(false);
  });

  it('does not drain after a failed turn or a pending choice — only an explicit signal reopens it', async () => {
    const h = harness();
    enqueue(h.queue, event({ ts: '1.1' }));
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');

    h.pending[0].settle({ result: 'blocked', reason: 'security ASK pending' });
    const report = await start.run.settled;

    expect(report.canDrain).toBe(false);
    expect(h.dispatcher.shouldYield(SESSION)).toBe(false);
    expect(await h.dispatcher.drainNext(SESSION)).toEqual({
      status: 'idle',
      reason: 'halted',
      detail: 'security ASK pending',
    });
    expect(h.dispatcher.drainHalt(SESSION)?.reason).toBe('blocked');
  });

  it('refuses to drain a frozen session and never unfreezes it on its own', async () => {
    const h = harness();
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    h.queue.freeze(SESSION, 'user stop');

    const result = await h.dispatcher.drainNext(SESSION);

    expect(result).toEqual({ status: 'idle', reason: 'frozen', detail: 'user stop' });
    expect(h.dispatcher.shouldYield(SESSION)).toBe(false);
    expect(h.queue.get(SESSION, item.id)?.state).toBe('paused');
    expect(h.queue.freezeReason(SESSION)).toBe('user stop');

    // A26: a fresh idle message still dispatches, and the paused item stays paused.
    expect(h.dispatcher.runInitial(SESSION, event({ ts: '1.2' })).status).toBe('dispatched');
    expect(h.queue.get(SESSION, item.id)?.state).toBe('paused');
    expect(h.queue.freezeReason(SESSION)).toBe('user stop');
  });

  it('drains a message that arrived AFTER the freeze, while the parked ones wait for Resume', async () => {
    const h = harness();
    const parked = enqueue(h.queue, event({ ts: '1.1' }));
    h.queue.freeze(SESSION, 'user stop');
    const fresh = enqueue(h.queue, event({ ts: '1.2' }));

    // The freeze holds back what it parked. This message was never at risk of
    // being replayed — it has not run at all yet.
    expect(h.dispatcher.shouldYield(SESSION)).toBe(true);
    const drained = await h.dispatcher.drainNext(SESSION);

    if (drained.status !== 'dispatched') throw new Error(`expected dispatch, got ${drained.status}`);
    expect(drained.run.itemId).toBe(fresh.id);
    expect(h.queue.get(SESSION, parked.id)?.state).toBe('paused');
    expect(h.queue.freezeReason(SESSION)).toBe('user stop'); // nothing unfroze itself
  });
});

describe('FollowupDispatcher send now', () => {
  it('waits for the interrupted run to fully settle before the fresh dispatch', async () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0', text: 'long turn' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const sending = click(h, item.id);
    await tick();

    // Abort signalled, teardown NOT done: no fresh dispatch may exist yet.
    expect(h.interrupt).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.queue.get(SESSION, item.id)?.state).toBe('reserved');
    expect(h.dispatcher.isBusy(SESSION)).toBe(true);

    h.pending[0].settle({ result: 'interrupted', reason: 'send-now' });
    const result = await sending;

    expect(result.status).toBe('dispatched');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.queue.get(SESSION, item.id)?.state).toBe('dispatched');
    // Ownership guard: the old run's completion must not clear the new live run.
    expect(h.dispatcher.isBusy(SESSION)).toBe(true);
  });

  it('fences the surface epoch after the abort lands, before the successor dispatch', async () => {
    const h = harness();
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const sending = click(h, item.id);
    await tick();
    h.pending[0].settle({ result: 'interrupted' });
    const result = await sending;
    if (result.status !== 'dispatched') throw new Error('expected dispatch');

    // Ordering ruling (round 2): the fence follows the delivered abort — until
    // then the dying turn is still the current one and must keep its surface.
    expect(h.order).toEqual(['dispatch', 'interrupt', 'invalidate', 'dispatch']);
    expect(h.invalidateSurface).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: SESSION, supersededTurnEpoch: start.run.turnEpoch }),
    );
    expect(result.run.turnEpoch).toBeGreaterThan(start.run.turnEpoch);
  });

  it('lets exactly one of two clicks abort the live run', async () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    // Both clicks carry the same rendered payload — a real double click.
    const first = click(h, item.id);
    const second = click(h, item.id);
    await tick();

    expect(h.interrupt).toHaveBeenCalledTimes(1);
    // The loser is fenced out by the item's own CAS token: the winner reserved
    // it, so its epoch moved. (The turn generation cannot be the fence here —
    // it is not advanced until the abort is actually delivered.)
    expect(await second).toEqual({ status: 'rejected', reason: 'stale-epoch', detail: expect.any(String) });

    h.pending[0].settle({ result: 'interrupted' });
    expect((await first).status).toBe('dispatched');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it('gives the auto drain and a concurrent send now a single winner', async () => {
    const h = harness();
    const first = enqueue(h.queue, event({ ts: '1.1' }));
    const second = enqueue(h.queue, event({ ts: '1.2' }));

    const sending = click(h, second.id);
    const draining = h.dispatcher.drainNext(SESSION);
    const [sendResult, drainResult] = await Promise.all([sending, draining]);

    expect(drainResult.status).toBe('dispatched');
    // The drain opened a new generation, so the click's control is now stale.
    expect(sendResult).toEqual({ status: 'rejected', reason: 'stale-turn-epoch', detail: expect.any(String) });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.queue.get(SESSION, first.id)?.state).toBe('dispatched');
    expect(h.queue.get(SESSION, second.id)?.state).toBe('queued'); // FIFO position kept
    expect(h.queue.get(SESSION, second.id)?.seq).toBe(second.seq);
  });

  it('loses the reservation to a dispatch the queue is already setting up', async () => {
    const h = harness();
    const first = enqueue(h.queue, event({ ts: '1.1' }));
    const second = enqueue(h.queue, event({ ts: '1.2' }));
    // Somebody else (not this dispatcher, so no new generation) already holds a
    // claim: the queue itself is the arbiter that rejects the reservation.
    expect(h.queue.claimNext(SESSION).ok).toBe(true);

    const result = await click(h, second.id);

    expect(result).toEqual({ status: 'rejected', reason: 'reserve-lost', detail: expect.stringContaining('busy') });
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.queue.get(SESSION, first.id)?.state).toBe('claimed');
    expect(h.queue.get(SESSION, second.id)?.state).toBe('queued');
    expect(h.queue.get(SESSION, second.id)?.seq).toBe(second.seq);
  });

  it('leaves the item untouched when canInterrupt denies the click', async () => {
    const h = harness({
      authorizeInterrupt: vi.fn(async () => ({ allowed: false, reason: 'canInterrupt=false' }) as const),
    });
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const result = await click(h, item.id);

    expect(result).toEqual({ status: 'rejected', reason: 'interrupt-denied', detail: 'canInterrupt=false' });
    expect(h.interrupt).not.toHaveBeenCalled();
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.epoch).toBe(item.epoch); // not even a reserve/rollback round trip
    expect(stored?.stateReason).toBeUndefined();
    expect(h.dispatch).toHaveBeenCalledTimes(1); // only the original run
  });

  it('rolls the reservation back and dispatches nothing when the author may not execute', async () => {
    const h = harness({
      authorizeDispatch: vi.fn(async () => ({ allowed: false, reason: 'author lacks permission' }) as const),
    });
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const sending = click(h, item.id);
    await tick();
    h.pending[0].settle({ result: 'interrupted' });
    const result = await sending;

    expect(result).toEqual({ status: 'rejected', reason: 'dispatch-denied', detail: 'author lacks permission' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.seq).toBe(item.seq);
    expect(stored?.stateReason).toBe('author lacks permission');
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
  });

  it('keeps the clicker out of the dispatched payload', async () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1', user: AUTHOR, text: '원문' }));

    const sending = click(h, item.id);
    await tick();
    h.pending[0].settle({ result: 'interrupted' });
    await sending;

    const request = h.dispatch.mock.calls[1][0] as DispatchRequest;
    expect(request.message.user).toBe(AUTHOR);
    expect(request.message.text).toBe('원문');
    expect(request.requestedBy).toBe(CLICKER);
    expect(request.kind).toBe('send-now');
    expect(h.authorizeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: SESSION, requestedBy: CLICKER }),
    );
    expect(h.authorizeDispatch.mock.calls[0][0].item.message.user).toBe(AUTHOR);
  });

  it('abandons the send when the reservation is taken away during teardown', async () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const sending = click(h, item.id);
    await tick();
    h.queue.freeze(SESSION, 'user stop'); // reserved → paused while we wait for teardown
    h.pending[0].settle({ result: 'interrupted' });
    const result = await sending;

    expect(result).toEqual({ status: 'rejected', reason: 'reservation-lost', detail: expect.any(String) });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.queue.get(SESSION, item.id)?.state).toBe('paused');
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
  });

  it('takes a steered item back out of the SDK channel and dispatches it as a fresh turn', async () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0', text: 'long turn' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const steered = h.dispatcher.steer(SESSION, item.id, item.epoch, () => true);
    if (steered.status !== 'steered') throw new Error(`steer failed: ${steered.reason}`);

    const sending = click(h, item.id);
    await tick();
    // The steer is undone before the reservation, so the ordinary Send now
    // transaction runs unchanged from here.
    expect(h.queue.get(SESSION, item.id)?.state).toBe('reserved');

    h.pending[0].settle({ result: 'interrupted', reason: 'send-now' });
    const result = await sending;

    expect(result.status).toBe('dispatched');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('dispatched');
    expect(stored?.steerUuid).toBeUndefined();
    expect(h.notices).toContainEqual({
      type: 'item-unsteered',
      sessionKey: SESSION,
      itemId: item.id,
      reason: 'send now',
    });
    // The happy path never re-attaches the uuid: exactly the one steer happened.
    expect(h.notices.filter((notice) => notice.type === 'item-steered')).toHaveLength(1);
  });

  it('puts the steer back, same uuid, when the reserve behind it is refused', async () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0', text: 'long turn' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const sibling = enqueue(h.queue, event({ ts: '1.2' }));
    const steered = h.dispatcher.steer(SESSION, item.id, item.epoch, () => true);
    if (steered.status !== 'steered') throw new Error(`steer failed: ${steered.reason}`);
    // A competing Send now takes the session's single reservation first.
    const taken = h.queue.reserve(SESSION, sibling.id, sibling.epoch, h.queue.getTurnEpoch(SESSION));
    if (!taken.ok) throw new Error('setup failed');

    const result = await click(h, item.id);

    expect(result).toEqual({ status: 'rejected', reason: 'reserve-lost', detail: expect.any(String) });
    // The SDK still holds the copy we pushed, so the row must still name it —
    // left `queued` the drain would deliver the same message a second time.
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('steered');
    expect(stored?.steerUuid).toBe(steered.uuid);
    expect(h.notices.filter((notice) => notice.type === 'item-steered')).toEqual([
      { type: 'item-steered', sessionKey: SESSION, itemId: item.id, uuid: steered.uuid },
      { type: 'item-steered', sessionKey: SESSION, itemId: item.id, uuid: steered.uuid },
    ]);
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('puts the steer back, same uuid, when the interrupt never lands', async () => {
    const h = harness({
      interrupt: vi.fn(async () => {
        throw new Error('abort channel gone');
      }),
    });
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0', text: 'long turn' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const steered = h.dispatcher.steer(SESSION, item.id, item.epoch, () => true);
    if (steered.status !== 'steered') throw new Error(`steer failed: ${steered.reason}`);

    const result = await click(h, item.id);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'interrupt-failed',
      detail: expect.stringContaining('abort channel gone'),
    });
    // The turn is still running and still holding the pushed copy, so the row
    // goes back to `steered` under the SAME uuid — the receipt that is still
    // coming names that one and nothing else.
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('steered');
    expect(stored?.steerUuid).toBe(steered.uuid);
    expect(h.dispatcher.isBusy(SESSION)).toBe(true); // the victim keeps the session
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    // A receipt for that uuid still settles the right row.
    expect(h.dispatcher.markConsumed(SESSION, steered.uuid).ok).toBe(true);
  });

  it('rejects a click rendered before the steer and leaves the item steered', async () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const staleEpoch = item.epoch; // rendered while the item was still `queued`
    const steered = h.dispatcher.steer(SESSION, item.id, item.epoch, () => true);
    if (steered.status !== 'steered') throw new Error(`steer failed: ${steered.reason}`);

    const result = await h.dispatcher.sendNow(SESSION, item.id, staleEpoch, CLICKER, h.queue.getTurnEpoch(SESSION));

    expect(result).toEqual({ status: 'rejected', reason: 'stale-epoch', detail: expect.any(String) });
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('steered');
    expect(stored?.steerUuid).toBe(steered.uuid);
    expect(h.dispatch).toHaveBeenCalledTimes(1); // only the original run
    expect(h.interrupt).not.toHaveBeenCalled();
  });
});

describe('FollowupDispatcher interrupted item disposition', () => {
  it('records a cut-short item through markInterrupted — never as failed', async () => {
    const h = harness();
    const running = enqueue(h.queue, event({ ts: '1.1' }));
    const drained = await h.dispatcher.drainNext(SESSION);
    if (drained.status !== 'dispatched') throw new Error('expected dispatch');
    const jumper = enqueue(h.queue, event({ ts: '1.2' }));

    const sending = click(h, jumper.id);
    await tick();
    h.pending[0].settle({ result: 'interrupted', reason: 'send-now' });
    await sending;
    const report = await drained.run.settled;

    expect(h.markInterrupted).toHaveBeenCalledWith(SESSION, running.id, expect.any(Number), 'send-now');
    expect(report.itemDisposition).toBe('uncertain');
    expect(h.queue.get(SESSION, running.id)?.state).not.toBe('failed');
    expect(h.notices).toContainEqual(
      expect.objectContaining({ type: 'item-uncertain', itemId: running.id, recorded: true }),
    );
  });

  it('reports the fact when the queue refuses the transition — still never failed', async () => {
    const queue = new FollowupQueue();
    const markInterrupted = vi.fn(() => ({ ok: false, reason: 'invalid-state' }) as const);
    const h = harness({ queue: portOf(queue, { markInterrupted }) });
    const running = enqueue(queue, event({ ts: '1.1' }));
    const drained = await h.dispatcher.drainNext(SESSION);
    if (drained.status !== 'dispatched') throw new Error('expected dispatch');
    const jumper = enqueue(queue, event({ ts: '1.2' }));

    const sending = click(h, jumper.id);
    await tick();
    h.pending[0].settle({ result: 'interrupted', reason: 'send-now' });
    await sending;
    const report = await drained.run.settled;

    expect(report.itemDisposition).toBe('uncertain-unrecorded');
    expect(queue.get(SESSION, running.id)?.state).not.toBe('failed');
    expect(h.notices).toContainEqual(
      expect.objectContaining({ type: 'item-uncertain', itemId: running.id, recorded: false }),
    );
  });

  it('settles a confirmed failure as failed and halts the drain', async () => {
    const h = harness();
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const drained = await h.dispatcher.drainNext(SESSION);
    if (drained.status !== 'dispatched') throw new Error('expected dispatch');

    h.pending[0].settle({ result: 'error', reason: 'model 500' });
    const report = await drained.run.settled;

    expect(report.itemDisposition).toBe('failed');
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('failed');
    expect(stored?.stateReason).toBe('model 500');
    expect(h.dispatcher.drainHalt(SESSION)).toEqual({ reason: 'error', detail: 'model 500' });
  });
});

describe('FollowupDispatcher failure injection', () => {
  it('still settles the run when the queue throws while recording the outcome', async () => {
    const queue = new FollowupQueue();
    const h = harness({
      queue: portOf(queue, {
        settle: () => {
          throw new Error('store unavailable');
        },
      }),
    });
    enqueue(queue, event({ ts: '1.1' }));
    const drained = await h.dispatcher.drainNext(SESSION);
    if (drained.status !== 'dispatched') throw new Error('expected dispatch');

    h.pending[0].settle({ result: 'safe' });
    const report = await drained.run.settled; // must resolve — a strand would time out

    expect(report.itemDisposition).toBe('none');
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
    expect(h.dispatcher.drainHalt(SESSION)?.reason).toBe('error');
    expect(h.dispatcher.drainHalt(SESSION)?.detail).toContain('store unavailable');
  });

  it('keeps dispatching when the notify observer throws', async () => {
    const h = harness({
      notify: () => {
        throw new Error('observer boom');
      },
    });

    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    h.pending[0].settle({ result: 'safe' });
    const report = await start.run.settled;

    expect(report.canDrain).toBe(true);
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
  });

  it('completes the send when the surface fence throws, and reports the observer failure', async () => {
    const h = harness({
      invalidateSurface: () => {
        throw new Error('fence boom');
      },
    });
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const sending = click(h, item.id);
    await tick();
    h.pending[0].settle({ result: 'interrupted' });
    const result = await sending;

    expect(result.status).toBe('dispatched');
    expect(h.interrupt).toHaveBeenCalledTimes(1);
    expect(h.notices).toContainEqual(expect.objectContaining({ type: 'observer-failed', hook: 'invalidate-surface' }));
  });

  it('rejects promptly when the interrupt throws, without waiting on the un-aborted victim', async () => {
    const h = harness({
      interrupt: vi.fn(async () => {
        throw new Error('executor gone');
      }),
    });
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    // The victim was never aborted, so its promise is NEVER settled below.
    const result = await click(h, item.id);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'interrupt-failed',
      detail: expect.stringContaining('executor gone'),
    });
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.seq).toBe(item.seq);
    expect(h.dispatch).toHaveBeenCalledTimes(1);

    // The still-running victim must own the session again — a rejection may not
    // open an overlap window for a brand-new dispatch.
    expect(h.dispatcher.isBusy(SESSION)).toBe(true);
    expect(h.dispatcher.snapshot(SESSION).kind).toBe('initial');
    expect(h.dispatcher.runInitial(SESSION, event({ ts: '1.2' })).status).toBe('busy');
    expect(await h.dispatcher.drainNext(SESSION)).toEqual({
      status: 'idle',
      reason: 'busy',
      detail: expect.any(String),
    });

    // RULING (round 2): a failed interrupt must not cost the live run its
    // render authority. No abort was delivered and no successor exists, so the
    // generation is NEVER advanced (not advanced-then-decremented) and the
    // surface is never fenced — the still-running turn keeps writing its header.
    expect(h.dispatcher.snapshot(SESSION).turnEpoch).toBe(start.run.turnEpoch);
    expect(h.invalidateSurface).not.toHaveBeenCalled();
    expect(h.dispatcher.controlPayload(SESSION, item.id)?.turnEpoch).toBe(start.run.turnEpoch);
    // The rollback succeeded, so the lane is still healthy — no halt, no notice.
    expect(h.dispatcher.drainHalt(SESSION)).toBeUndefined();
    expect(h.notices).not.toContainEqual(expect.objectContaining({ type: 'drain-halted' }));
  });

  it('halts the lane when a failed interrupt cannot be rolled back either', async () => {
    const queue = new FollowupQueue();
    const h = harness({
      queue: portOf(queue, {
        rollback: () => {
          throw new Error('rollback store down');
        },
      }),
      interrupt: vi.fn(async () => {
        throw new Error('executor gone');
      }),
    });
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await click(h, item.id);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'interrupt-failed',
      detail: expect.stringContaining('executor gone'),
    });
    // A `reserved` orphan refuses every later claim and reservation while this
    // service reports itself idle — the same silent stall as the other three
    // rollback-failure sites, so it halts just as loudly.
    expect(queue.get(SESSION, item.id)?.state).toBe('reserved');
    expect(h.dispatcher.drainHalt(SESSION)?.reason).toBe('error');
    expect(h.dispatcher.drainHalt(SESSION)?.detail).toContain('executor gone');
    expect(h.dispatcher.drainHalt(SESSION)?.detail).toContain('rollback store down');
    expect(h.notices).toContainEqual(expect.objectContaining({ type: 'drain-halted', reason: 'error' }));
  });

  it('advances the generation only after the abort is delivered, and before the successor', async () => {
    const abort = deferred();
    const h = harness({ interrupt: vi.fn(() => abort.promise) });
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const sending = click(h, item.id);
    await tick();

    // Interrupt in flight: the victim is still the current turn (A28 — there is
    // no successor yet), but the session is already locked to this send.
    expect(h.interrupt).toHaveBeenCalledTimes(1);
    expect(h.dispatcher.snapshot(SESSION).turnEpoch).toBe(start.run.turnEpoch);
    expect(h.invalidateSurface).not.toHaveBeenCalled();
    expect(h.queue.get(SESSION, item.id)?.state).toBe('reserved');
    expect(h.dispatcher.runInitial(SESSION, event({ ts: '1.2' })).status).toBe('busy');
    expect((await click(h, item.id)).status).toBe('rejected'); // double click fenced
    expect(h.interrupt).toHaveBeenCalledTimes(1);

    abort.resolve();
    await tick();

    // Abort delivered → supersede now: generation advanced and surface fenced,
    // still before the successor dispatch (the victim has not torn down yet).
    expect(h.dispatcher.snapshot(SESSION).turnEpoch).toBeGreaterThan(start.run.turnEpoch);
    expect(h.invalidateSurface).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: SESSION, supersededTurnEpoch: start.run.turnEpoch }),
    );
    expect(h.dispatch).toHaveBeenCalledTimes(1);

    h.pending[0].settle({ result: 'interrupted' });
    const result = await sending;
    if (result.status !== 'dispatched') throw new Error('expected dispatch');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(result.run.turnEpoch).toBeGreaterThan(start.run.turnEpoch);
  });

  it('settles a blocked drained item as uncertain so the lane is not wedged', async () => {
    const h = harness();
    const parked = enqueue(h.queue, event({ ts: '1.1' }));
    const next = enqueue(h.queue, event({ ts: '1.2' }));
    const drained = await h.dispatcher.drainNext(SESSION);
    if (drained.status !== 'dispatched') throw new Error('expected dispatch');

    h.pending[0].settle({ result: 'blocked', reason: 'security ASK pending' });
    const report = await drained.run.settled;

    // Potentially executed, outcome unknown: uncertain, never resolved/failed.
    expect(report.itemDisposition).toBe('uncertain');
    const stored = h.queue.get(SESSION, parked.id);
    expect(stored?.state).toBe('uncertain');
    expect(stored?.stateReason).toBe('security ASK pending');
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
    expect(h.dispatcher.drainHalt(SESSION)?.reason).toBe('blocked');

    // After the user answers, the lane moves again — and the parked item is
    // NOT replayed; only the next queued item goes.
    h.dispatcher.clearDrainHalt(SESSION, 'user-action');
    const resumed = await h.dispatcher.drainNext(SESSION);

    expect(resumed.status).toBe('dispatched');
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect((h.dispatch.mock.calls[1][0] as DispatchRequest).item?.id).toBe(next.id);
    expect(h.queue.get(SESSION, parked.id)?.state).toBe('uncertain');
  });

  it('maps the queue own stale-turn refusal onto the same rejection vocabulary', async () => {
    const queue = new FollowupQueue();
    // A host reading the generation from anywhere but the queue: this service's
    // pre-check passes and the QUEUE is the one that catches the stale control.
    const h = harness({ queue: portOf(queue, { getTurnEpoch: () => 99 }) });
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await h.dispatcher.sendNow(SESSION, item.id, item.epoch, CLICKER, 99);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'stale-turn-epoch',
      detail: 'queue refused: stale-turn',
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
    expect(queue.get(SESSION, item.id)?.state).toBe('queued');
  });

  it('rolls the claim back and halts when the queue refuses a turn generation', async () => {
    const queue = new FollowupQueue();
    const h = harness({
      queue: portOf(queue, {
        beginTurn: () => {
          throw new Error('generation store down');
        },
        getTurnEpoch: () => 0,
      }),
    });
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await h.dispatcher.drainNext(SESSION);

    expect(result).toEqual({
      status: 'aborted',
      itemId: item.id,
      detail: expect.stringContaining('turn generation unavailable'),
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
    expect(h.dispatcher.drainHalt(SESSION)?.reason).toBe('error');
    const stored = queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.seq).toBe(item.seq);
  });

  it('fails honestly when the generation is refused after the abort was delivered', async () => {
    const queue = new FollowupQueue();
    let generations = 0;
    const h = harness({
      // The first dispatch gets its generation from the real queue; the store
      // goes down before the `Send now` can take the next one.
      queue: portOf(queue, {
        beginTurn: (sessionKey) => {
          generations += 1;
          if (generations > 1) throw new Error('generation store down');
          return queue.beginTurn(sessionKey);
        },
      }),
    });
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await click(h, item.id);

    expect(result).toEqual({
      status: 'rejected',
      reason: 'dispatch-unavailable',
      detail: expect.stringContaining('turn generation unavailable'),
    });
    // The abort WAS delivered — the old turn is dying but no successor can open.
    expect(h.interrupt).toHaveBeenCalledTimes(1);
    expect(h.invalidateSurface).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const stored = queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.seq).toBe(item.seq);

    // The aborted run stays tracked until it settles: no overlap window.
    expect(h.dispatcher.isBusy(SESSION)).toBe(true);
    expect(h.dispatcher.snapshot(SESSION).kind).toBe('initial');
    h.pending[0].settle({ result: 'interrupted' });
    await start.run.settled;
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
    expect(h.dispatch).toHaveBeenCalledTimes(1); // nothing replayed
  });

  it('rolls the reservation back to queued when the queue refuses the promotion', async () => {
    const queue = new FollowupQueue();
    const h = harness({
      queue: portOf(queue, {
        promote: () => {
          throw new Error('promote store down');
        },
      }),
    });
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await click(h, item.id);

    expect(result.status).toBe('rejected');
    expect(h.dispatch).not.toHaveBeenCalled();
    // An item abandoned as `reserved` answers `busy` to every later claim while
    // this service reports itself idle — the queue and the lane would disagree
    // forever with nothing said out loud.
    const stored = queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.seq).toBe(item.seq);
    expect(h.dispatcher.isBusy(SESSION)).toBe(false);
    expect((await h.dispatcher.drainNext(SESSION)).status).toBe('dispatched');
  });

  it('halts the lane when a refused promotion cannot be rolled back either', async () => {
    const queue = new FollowupQueue();
    const h = harness({
      queue: portOf(queue, {
        promote: () => {
          throw new Error('promote store down');
        },
        rollback: () => {
          throw new Error('rollback store down');
        },
      }),
    });
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await click(h, item.id);

    expect(result.status).toBe('rejected');
    expect(h.dispatch).not.toHaveBeenCalled();
    // The orphan survives — but it is announced, never silent.
    expect(queue.get(SESSION, item.id)?.state).toBe('reserved');
    expect(h.dispatcher.drainHalt(SESSION)?.reason).toBe('error');
    expect(h.dispatcher.drainHalt(SESSION)?.detail).toContain('rollback store down');
    expect(h.notices).toContainEqual(expect.objectContaining({ type: 'drain-halted', reason: 'error' }));
  });

  it('halts the drain when a refused markDispatched cannot be rolled back either', async () => {
    const queue = new FollowupQueue();
    const h = harness({
      queue: portOf(queue, {
        markDispatched: () => {
          throw new Error('dispatch store down');
        },
        rollback: () => {
          throw new Error('rollback store down');
        },
      }),
    });
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await h.dispatcher.drainNext(SESSION);

    expect(result).toEqual({
      status: 'aborted',
      itemId: item.id,
      detail: expect.stringContaining('dispatch store down'),
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    // An orphan `claimed` item blocks every later drain (`followup-queue.ts:350`),
    // so the lane must stop loudly instead of looking idle.
    expect(queue.get(SESSION, item.id)?.state).toBe('claimed');
    expect(h.dispatcher.drainHalt(SESSION)?.reason).toBe('error');
    expect(h.dispatcher.drainHalt(SESSION)?.detail).toContain('rollback store down');
    expect(h.notices).toContainEqual(expect.objectContaining({ type: 'drain-halted', reason: 'error' }));
  });

  it('halts the lane when a send-now markDispatched and its rollback both fail', async () => {
    const queue = new FollowupQueue();
    const h = harness({
      queue: portOf(queue, {
        markDispatched: () => {
          throw new Error('dispatch store down');
        },
        rollback: () => {
          throw new Error('rollback store down');
        },
      }),
    });
    const item = enqueue(queue, event({ ts: '1.1' }));

    const result = await click(h, item.id);

    expect(result.status).toBe('rejected');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(queue.get(SESSION, item.id)?.state).toBe('claimed');
    expect(h.dispatcher.drainHalt(SESSION)?.reason).toBe('error');
    expect(h.dispatcher.drainHalt(SESSION)?.detail).toContain('rollback store down');
    expect(h.notices).toContainEqual(expect.objectContaining({ type: 'drain-halted', reason: 'error' }));
  });

  it('rejects a click whose live run was replaced while authorization was pending', async () => {
    const queue = new FollowupQueue();
    let turnEpoch = 0;
    const port = portOf(queue, {
      beginTurn: () => {
        turnEpoch += 1;
        return turnEpoch;
      },
      getTurnEpoch: () => turnEpoch,
    });
    let supersedeDuringAuth = false;
    const h = harness({
      queue: port,
      authorizeInterrupt: vi.fn(async () => {
        // A new turn takes the session while the permission check is pending.
        if (supersedeDuringAuth) port.beginTurn(SESSION);
        return { allowed: true } as const;
      }),
    });
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(queue, event({ ts: '1.1' }));
    supersedeDuringAuth = true;

    const result = await click(h, item.id);

    expect(result).toEqual({ status: 'rejected', reason: 'stale-turn-epoch', detail: expect.any(String) });
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(queue.get(SESSION, item.id)?.state).toBe('queued');
    expect(queue.get(SESSION, item.id)?.epoch).toBe(item.epoch);
  });
});

describe('FollowupDispatcher auto-steering (06 §3.2)', () => {
  it('pushes a queued item into the live turn without dispatching or superseding it', () => {
    const h = harness();
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0', text: 'long turn' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const push = vi.fn(() => true);

    const result = h.dispatcher.steer(SESSION, item.id, item.epoch, push);

    if (result.status !== 'steered') throw new Error(`steer rejected: ${result.reason}`);
    expect(push).toHaveBeenCalledWith(result.uuid);
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('steered');
    expect(stored?.steerUuid).toBe(result.uuid);
    // No new turn, no abort, no second slot: the running turn keeps everything.
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.dispatcher.snapshot(SESSION).turnEpoch).toBe(start.run.turnEpoch);
    expect(h.notices).toContainEqual({ type: 'item-steered', sessionKey: SESSION, itemId: item.id, uuid: result.uuid });
  });

  it('refuses when nothing is running — the drain, not a steer, owns an idle session', () => {
    const h = harness();
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const push = vi.fn(() => true);

    const result = h.dispatcher.steer(SESSION, item.id, item.epoch, push);

    expect(result).toEqual({ status: 'rejected', reason: 'not-busy', detail: expect.any(String) });
    expect(push).not.toHaveBeenCalled();
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.epoch).toBe(item.epoch); // untouched, not a round trip
  });

  it('puts the item back in the queue when the channel refuses the push', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const result = h.dispatcher.steer(SESSION, item.id, item.epoch, () => false);

    expect(result).toEqual({ status: 'rejected', reason: 'push-refused', detail: expect.any(String) });
    const stored = h.queue.get(SESSION, item.id);
    expect(stored?.state).toBe('queued');
    expect(stored?.seq).toBe(item.seq); // same FIFO position
    expect(stored?.steerUuid).toBeUndefined();
    // The row says what actually happened — the turn WAS live, the channel just
    // did not take the message.
    expect(stored?.stateReason).toBe('the input channel refused the message');
    expect(h.notices).toContainEqual({
      type: 'item-unsteered',
      sessionKey: SESSION,
      itemId: item.id,
      reason: 'the input channel refused the message',
    });
    expect(h.notices).not.toContainEqual(expect.objectContaining({ type: 'item-steered' }));
    // Still drainable at the next boundary — a refused push loses nothing.
    expect(h.queue.claimNext(SESSION).ok).toBe(true);
  });

  it('treats a throwing channel as a refusal, never as a delivery', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));

    const result = h.dispatcher.steer(SESSION, item.id, item.epoch, () => {
      throw new Error('channel closed');
    });

    expect(result).toEqual({
      status: 'rejected',
      reason: 'push-refused',
      detail: expect.stringContaining('channel closed'),
    });
    expect(h.queue.get(SESSION, item.id)?.state).toBe('queued');
    expect(h.queue.get(SESSION, item.id)?.stateReason).toContain('channel closed');
  });

  it('refuses to steer while a Send now is setting up the replacement turn', async () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const jumper = enqueue(h.queue, event({ ts: '1.1' }));
    const item = enqueue(h.queue, event({ ts: '1.2' }));
    const sending = click(h, jumper.id);
    await tick();
    // The replacement run already owns the slot; the live turn is a dead man
    // walking, and its settlement frame will never name a message pushed now.
    expect(h.dispatcher.isBusy(SESSION)).toBe(true);
    expect(h.queue.get(SESSION, jumper.id)?.state).toBe('reserved');
    const push = vi.fn(() => true);

    const result = h.dispatcher.steer(SESSION, item.id, item.epoch, push);

    expect(result).toEqual({ status: 'rejected', reason: 'busy', detail: expect.stringContaining(jumper.id) });
    expect(push).not.toHaveBeenCalled();
    expect(h.queue.get(SESSION, item.id)).toEqual(item); // untouched — the drain still owns it

    h.pending[0].settle({ result: 'interrupted', reason: 'send-now' });
    await sending;
  });

  it('sweeps every steered item back to the queue at turn end, with one notice each', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const first = enqueue(h.queue, event({ ts: '1.1' }));
    const second = enqueue(h.queue, event({ ts: '1.2' }));
    const untouched = enqueue(h.queue, event({ ts: '1.3' })); // never steered
    const a = h.dispatcher.steer(SESSION, first.id, first.epoch, () => true);
    const b = h.dispatcher.steer(SESSION, second.id, second.epoch, () => true);
    if (a.status !== 'steered' || b.status !== 'steered') throw new Error('expected steers');

    const moved = h.dispatcher.unsteerAll(SESSION, '턴 종료 — 수신 확인 없음');

    expect(moved.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(h.notices.filter((notice) => notice.type === 'item-unsteered')).toEqual([
      { type: 'item-unsteered', sessionKey: SESSION, itemId: first.id, reason: '턴 종료 — 수신 확인 없음' },
      { type: 'item-unsteered', sessionKey: SESSION, itemId: second.id, reason: '턴 종료 — 수신 확인 없음' },
    ]);
    // Drainable again — a missed settlement can no longer strand a message in a
    // state the drain cannot see.
    expect(h.queue.list(SESSION).map((entry) => entry.state)).toEqual(['queued', 'queued', 'queued']);
    expect(h.queue.get(SESSION, untouched.id)).toEqual(untouched);
    expect(h.dispatcher.shouldYield(SESSION)).toBe(true);
    // Idempotent: a sweep after a full set of receipts changes nothing.
    expect(h.dispatcher.unsteerAll(SESSION, 'again')).toEqual([]);
    expect(h.notices.filter((notice) => notice.type === 'item-unsteered')).toHaveLength(2);
  });

  it('refuses to steer an item the freeze parked', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    h.queue.freeze(SESSION, 'stop pressed');
    const paused = h.queue.get(SESSION, item.id);
    if (!paused) throw new Error('setup failed');
    const push = vi.fn(() => true);

    const result = h.dispatcher.steer(SESSION, paused.id, paused.epoch, push);

    expect(result).toEqual({ status: 'rejected', reason: 'frozen', detail: expect.stringContaining('frozen') });
    expect(push).not.toHaveBeenCalled();
  });

  it('steers a message that arrived after the freeze into the still-live turn', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const parked = enqueue(h.queue, event({ ts: '1.1' }));
    h.queue.freeze(SESSION, 'process restart');
    const fresh = enqueue(h.queue, event({ ts: '1.2' }));
    const push = vi.fn(() => true);

    const result = h.dispatcher.steer(SESSION, fresh.id, fresh.epoch, push);

    expect(result.status).toBe('steered');
    expect(push).toHaveBeenCalledTimes(1);
    expect(h.queue.get(SESSION, fresh.id)?.state).toBe('steered');
    expect(h.queue.get(SESSION, parked.id)?.state).toBe('paused');
  });

  it('rejects a second push of the same item by its stale item epoch', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const first = h.dispatcher.steer(SESSION, item.id, item.epoch, () => true);
    if (first.status !== 'steered') throw new Error('expected steer');
    const push = vi.fn(() => true);

    const second = h.dispatcher.steer(SESSION, item.id, item.epoch, push);

    expect(second).toEqual({ status: 'rejected', reason: 'stale-epoch', detail: expect.any(String) });
    expect(push).not.toHaveBeenCalled();
    expect(h.queue.get(SESSION, item.id)?.steerUuid).toBe(first.uuid);
  });

  it('reports an unknown item and a refusing store in the caller’s vocabulary', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));

    expect(h.dispatcher.steer(SESSION, 'nope', 0, () => true)).toEqual({
      status: 'rejected',
      reason: 'not-found',
      detail: expect.any(String),
    });

    const queue = new FollowupQueue();
    const broken = harness({
      queue: portOf(queue, {
        steer: () => {
          throw new Error('disk full');
        },
      }),
    });
    broken.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(queue, event({ ts: '1.1' }));

    expect(broken.dispatcher.steer(SESSION, item.id, item.epoch, () => true)).toEqual({
      status: 'rejected',
      reason: 'dispatch-unavailable',
      detail: expect.stringContaining('disk full'),
    });
  });

  it('settles a steered item as consumed on the SDK receipt and reports it', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const steered = h.dispatcher.steer(SESSION, item.id, item.epoch, () => true);
    if (steered.status !== 'steered') throw new Error('expected steer');

    const consumed = h.dispatcher.markConsumed(SESSION, steered.uuid);

    expect(consumed.ok && consumed.item.state).toBe('resolved');
    expect(consumed.ok && consumed.item.stateReason).toBe('consumed');
    expect(h.notices).toContainEqual({
      type: 'item-consumed',
      sessionKey: SESSION,
      itemId: item.id,
      uuid: steered.uuid,
    });
    // A duplicate receipt reports the refusal and emits nothing.
    const again = h.dispatcher.markConsumed(SESSION, steered.uuid);
    expect(again).toEqual({ ok: false, reason: 'invalid-state' });
    expect(h.notices.filter((notice) => notice.type === 'item-consumed')).toHaveLength(1);
  });

  it('returns an unread item to the queue when the turn ends without consuming it (S3)', () => {
    const h = harness();
    h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    const item = enqueue(h.queue, event({ ts: '1.1' }));
    const steered = h.dispatcher.steer(SESSION, item.id, item.epoch, () => true);
    if (steered.status !== 'steered') throw new Error('expected steer');

    const unsteered = h.dispatcher.unsteer(SESSION, steered.uuid, 'still_queued at turn end');

    expect(unsteered.ok && unsteered.item.state).toBe('queued');
    expect(unsteered.ok && unsteered.item.seq).toBe(item.seq);
    expect(h.notices).toContainEqual({
      type: 'item-unsteered',
      sessionKey: SESSION,
      itemId: item.id,
      reason: 'still_queued at turn end',
    });
    expect(h.dispatcher.unsteer(SESSION, steered.uuid, 'again')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('keeps the drain available beside a steered item and never drains the steered one', async () => {
    const h = harness();
    const start = h.dispatcher.runInitial(SESSION, event({ ts: '1.0' }));
    if (start.status !== 'dispatched') throw new Error('expected dispatch');
    const steeredItem = enqueue(h.queue, event({ ts: '1.1' }));
    const sibling = enqueue(h.queue, event({ ts: '1.2' }));
    const steered = h.dispatcher.steer(SESSION, steeredItem.id, steeredItem.epoch, () => true);
    if (steered.status !== 'steered') throw new Error('expected steer');

    // The turn that was being steered into ends; the drain opens the next one.
    h.pending[0].settle({ result: 'safe' });
    await start.run.settled;
    const drained = await h.dispatcher.drainNext(SESSION);

    expect(drained.status).toBe('dispatched');
    expect(h.queue.get(SESSION, sibling.id)?.state).toBe('dispatched');
    expect(h.queue.get(SESSION, steeredItem.id)?.state).toBe('steered');
    expect(h.dispatcher.shouldYield(SESSION)).toBe(false); // no `queued` item is left
  });
});
