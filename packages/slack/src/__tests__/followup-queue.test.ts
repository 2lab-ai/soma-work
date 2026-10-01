import { describe, expect, it, vi } from 'vitest';
import {
  FOLLOWUP_CANCEL_DEFAULT_REASON,
  FOLLOWUP_QUEUE_DEFAULT_CAPACITY,
  type FollowupItem,
  FollowupQueue,
  type FollowupQueueSnapshot,
  FREEZE_PARKED_STATES,
} from '../followup-queue';
import type { MessageEvent } from '../pipeline/types';

const SESSION = 'C1:1700.000000';
const OTHER_SESSION = 'C1:1800.000000';

function event(over: Partial<MessageEvent> = {}): MessageEvent {
  return { user: 'U1', channel: 'C1', ts: '1700.000100', text: '진행중인거 알려줘?', ...over };
}

/** A structurally valid snapshot holding exactly one queued item, for constructor-validation tests. */
function snapshotWithOneItem(): FollowupQueueSnapshot {
  const source = new FollowupQueue();
  source.enqueue(SESSION, event({ ts: '1.1' }));
  return source.snapshot();
}

/** Push the oldest queued item into the (imaginary) live turn's input channel under `uuid`. */
function steerFirst(queue: FollowupQueue, uuid = 'uuid-1'): FollowupItem {
  const target = queue.list(SESSION).find((item) => item.state === 'queued');
  if (!target) throw new Error('no queued item to steer');
  const steered = queue.steer(SESSION, target.id, target.epoch, uuid);
  if (!steered.ok) throw new Error(`steer failed: ${steered.reason}`);
  return steered.item;
}

/** Drive one item all the way to `dispatched` so state-machine tests can start from mid-flight. */
function dispatchFirst(queue: FollowupQueue): { id: string; epoch: number } {
  const claimed = queue.claimNext(SESSION);
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`);
  const marked = queue.markDispatched(SESSION, claimed.item.id, claimed.item.epoch);
  if (!marked.ok) throw new Error(`markDispatched failed: ${marked.reason}`);
  return { id: marked.item.id, epoch: marked.item.epoch };
}

describe('FollowupQueue enqueue', () => {
  it('assigns monotone sequence numbers in arrival order (A4)', () => {
    const queue = new FollowupQueue();

    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    const second = queue.enqueue(SESSION, event({ ts: '1.2' }));
    const third = queue.enqueue(SESSION, event({ ts: '1.3' }));

    expect([first.status, second.status, third.status]).toEqual(['queued', 'queued', 'queued']);
    expect(queue.list(SESSION).map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(queue.list(SESSION).map((item) => item.message.ts)).toEqual(['1.1', '1.2', '1.3']);
  });

  it('keeps sequences independent per session', () => {
    const queue = new FollowupQueue();

    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const other = queue.enqueue(OTHER_SESSION, event({ ts: '1.2' }));

    expect(other.status).toBe('queued');
    expect(other.status === 'queued' && other.item.seq).toBe(1);
    expect(queue.list(SESSION)).toHaveLength(1);
  });

  it('dedups a redelivered Slack event by channel+ts inside the session (A3)', () => {
    const queue = new FollowupQueue();

    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    const replay = queue.enqueue(SESSION, event({ ts: '1.1', text: 'redelivery' }));

    expect(replay.status).toBe('duplicate');
    if (replay.status !== 'duplicate' || first.status !== 'queued') throw new Error('unexpected enqueue result');
    expect(replay.item.id).toBe(first.item.id);
    expect(queue.list(SESSION)).toHaveLength(1);
    expect(queue.list(SESSION)[0].message.text).toBe('진행중인거 알려줘?');
  });

  it('still dedups a redelivery after the original item reached a terminal state', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(queue);
    queue.settle(SESSION, dispatched.id, dispatched.epoch, 'resolved');

    const replay = queue.enqueue(SESSION, event({ ts: '1.1' }));

    expect(replay.status).toBe('duplicate');
    expect(queue.list(SESSION)).toHaveLength(1);
  });

  it('treats the same ts in another channel as a distinct event', () => {
    const queue = new FollowupQueue();

    queue.enqueue(SESSION, event({ channel: 'C1', ts: '1.1' }));
    const other = queue.enqueue(SESSION, event({ channel: 'C2', ts: '1.1' }));

    expect(other.status).toBe('queued');
    expect(queue.list(SESSION)).toHaveLength(2);
  });

  it('rejects visibly when the session is at capacity (A15)', () => {
    const save = vi.fn();
    const queue = new FollowupQueue({ capacity: 2, save });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    save.mockClear();

    const rejected = queue.enqueue(SESSION, event({ ts: '1.3' }));

    expect(rejected.status).toBe('capacity');
    expect(rejected.status === 'capacity' && rejected.capacity).toBe(2);
    expect(rejected.status === 'capacity' && rejected.pending).toBe(2);
    expect(queue.list(SESSION)).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
  });

  it('frees capacity once a failure is confirmed (ssot.md:157 terminal set)', () => {
    const queue = new FollowupQueue({ capacity: 1 });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(queue);
    queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'tool crash');

    const next = queue.enqueue(SESSION, event({ ts: '1.2' }));

    expect(next.status).toBe('queued');
  });

  it('counts only non-terminal items against capacity', () => {
    const queue = new FollowupQueue({ capacity: 1 });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(queue);
    queue.settle(SESSION, dispatched.id, dispatched.epoch, 'resolved');

    const next = queue.enqueue(SESSION, event({ ts: '1.2' }));

    expect(next.status).toBe('queued');
  });

  it('defaults capacity to 100', () => {
    const queue = new FollowupQueue();
    for (let i = 0; i < FOLLOWUP_QUEUE_DEFAULT_CAPACITY; i++) {
      expect(queue.enqueue(SESSION, event({ ts: `1.${i}` })).status).toBe('queued');
    }

    const rejected = queue.enqueue(SESSION, event({ ts: 'overflow' }));

    expect(rejected.status).toBe('capacity');
    expect(rejected.status === 'capacity' && rejected.capacity).toBe(100);
  });

  it('keeps the original text, files and author immune to later mutation of the raw event', () => {
    const queue = new FollowupQueue();
    const raw = event({
      ts: '1.1',
      user: 'U_AUTHOR',
      files: [
        {
          id: 'F1',
          name: 'spec.md',
          mimetype: 'text/markdown',
          filetype: 'markdown',
          url_private: 'https://x/1',
          url_private_download: 'https://x/1d',
          size: 12,
        },
      ],
    });

    const enqueued = queue.enqueue(SESSION, raw);
    raw.text = 'rewritten after enqueue';
    raw.user = 'U_CLICKER';
    raw.files?.splice(0, 1);
    if (enqueued.status === 'queued') enqueued.item.message.text = 'mutated through the result';

    const stored = queue.list(SESSION)[0];
    expect(stored.message.text).toBe('진행중인거 알려줘?');
    expect(stored.message.user).toBe('U_AUTHOR');
    expect(stored.message.files).toHaveLength(1);
    expect(stored.message.files?.[0].name).toBe('spec.md');
  });

  it('captures the context snapshot (working directory) taken at enqueue time', () => {
    const queue = new FollowupQueue();

    queue.enqueue(SESSION, event({ ts: '1.1' }), { workingDirectory: '/base/U_AUTHOR' });

    expect(queue.list(SESSION)[0].context.workingDirectory).toBe('/base/U_AUTHOR');
  });
});

describe('FollowupQueue persistence boundary', () => {
  it('hands the committed snapshot to save() before the enqueue returns', () => {
    const seen: FollowupQueueSnapshot[] = [];
    const queue = new FollowupQueue({ save: (snapshot) => seen.push(snapshot) });

    const result = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (result.status !== 'queued') throw new Error('setup failed');

    expect(seen).toHaveLength(1);
    expect(seen[0].sessions[0].items[0].id).toBe(result.item.id);
    expect(seen[0].sessions[0].items[0].state).toBe('queued');
  });

  it('does not mutate committed memory when persistence throws', () => {
    let failing = false;
    const queue = new FollowupQueue({
      save: () => {
        if (failing) throw new Error('disk full');
      },
    });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    failing = true;

    expect(() => queue.enqueue(SESSION, event({ ts: '1.2' }))).toThrow('disk full');
    expect(queue.list(SESSION)).toHaveLength(1);
    expect(queue.snapshot().sessions[0].nextSeq).toBe(2);
  });

  it('restores items and sequence position from an initial snapshot', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));

    const restored = new FollowupQueue({ snapshot: source.snapshot() });
    const next = restored.enqueue(SESSION, event({ ts: '1.2' }));

    expect(restored.list(SESSION).map((item) => item.message.ts)).toEqual(['1.1', '1.2']);
    expect(next.status === 'queued' && next.item.seq).toBe(2);
  });

  it('returns defensive clones from snapshot()', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));

    queue.snapshot().sessions[0].items[0].state = 'cancelled';

    expect(queue.list(SESSION)[0].state).toBe('queued');
  });
});

describe('FollowupQueue constructor validation (fail closed, never silently repaired)', () => {
  it('rejects a snapshot written by an unknown schema version', () => {
    const snapshot = snapshotWithOneItem();
    (snapshot as { version: number }).version = 99;

    expect(() => new FollowupQueue({ snapshot })).toThrow(/version/);
  });

  it('rejects a nextSeq that lags its own items instead of minting duplicate ids', () => {
    const snapshot = snapshotWithOneItem();
    snapshot.sessions[0].nextSeq = 1; // item seq 1 already exists

    expect(() => new FollowupQueue({ snapshot })).toThrow(/nextSeq/);
  });

  it('rejects duplicate item ids inside a session', () => {
    const snapshot = snapshotWithOneItem();
    const [item] = snapshot.sessions[0].items;
    snapshot.sessions[0].items.push({ ...item, seq: 2 });
    snapshot.sessions[0].nextSeq = 3;

    expect(() => new FollowupQueue({ snapshot })).toThrow(/duplicate item id/);
  });

  it('rejects duplicate sequence numbers inside a session', () => {
    const snapshot = snapshotWithOneItem();
    const [item] = snapshot.sessions[0].items;
    snapshot.sessions[0].items.push({ ...item, id: `${SESSION}#other` });
    snapshot.sessions[0].nextSeq = 2;

    expect(() => new FollowupQueue({ snapshot })).toThrow(/duplicate item seq/);
  });

  it('rejects duplicate session keys', () => {
    const snapshot = snapshotWithOneItem();
    snapshot.sessions.push(snapshot.sessions[0]);

    expect(() => new FollowupQueue({ snapshot })).toThrow(/duplicate session key/);
  });

  it('rejects a capacity that cannot hold anything', () => {
    expect(() => new FollowupQueue({ capacity: 0 })).toThrow(/capacity/);
    expect(() => new FollowupQueue({ capacity: -1 })).toThrow(/capacity/);
    expect(() => new FollowupQueue({ capacity: 1.5 })).toThrow(/capacity/);
  });
});

describe('FollowupQueue turn epoch (session turn generation, ssot.md:116-120)', () => {
  it('starts at 0 for an unknown session', () => {
    const queue = new FollowupQueue();

    expect(queue.getTurnEpoch(SESSION)).toBe(0);
  });

  it('advances and persists on every dispatch, including one with no queue item', () => {
    const saved: FollowupQueueSnapshot[] = [];
    const queue = new FollowupQueue({ save: (snapshot) => saved.push(snapshot) });

    const first = queue.beginTurn(SESSION); // plain user message, nothing queued
    const second = queue.beginTurn(SESSION);

    expect([first, second]).toEqual([1, 2]);
    expect(queue.getTurnEpoch(SESSION)).toBe(2);
    expect(saved[saved.length - 1].sessions[0].turnEpoch).toBe(2);
  });

  it('keeps the turn generation independent per session', () => {
    const queue = new FollowupQueue();
    queue.beginTurn(SESSION);

    expect(queue.getTurnEpoch(OTHER_SESSION)).toBe(0);
  });

  it('rejects a Send now button minted before a later turn started (A12/A28)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const target = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (target.status !== 'queued') throw new Error('setup failed');
    const buttonTurnEpoch = queue.getTurnEpoch(SESSION); // payload stamped for the UI
    queue.beginTurn(SESSION); // a whole new turn generation started meanwhile

    const clicked = queue.reserve(SESSION, target.item.id, target.item.epoch, buttonTurnEpoch);

    expect(clicked).toEqual({ ok: false, reason: 'stale-turn' });
    expect(queue.list(SESSION)[1].state).toBe('queued'); // rejection does not consume the item
  });

  it('accepts a Send now button carrying the current turn generation', () => {
    const queue = new FollowupQueue();
    const target = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (target.status !== 'queued') throw new Error('setup failed');
    queue.beginTurn(SESSION);

    const clicked = queue.reserve(SESSION, target.item.id, target.item.epoch, queue.getTurnEpoch(SESSION));

    expect(clicked.ok && clicked.item.state).toBe('reserved');
  });

  it('refuses a reservation that carries no turn generation at all (A12/A28)', () => {
    const queue = new FollowupQueue();
    const target = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (target.status !== 'queued') throw new Error('setup failed');

    // The fence is not optional: omitting it must not buy a caller a pass
    // through the stale-turn check, so the type forbids it AND the runtime
    // treats the missing generation as a mismatch.
    // @ts-expect-error — expectedTurnEpoch is required; this call is the violation under test.
    const clicked = queue.reserve(SESSION, target.item.id, target.item.epoch);

    expect(clicked).toEqual({ ok: false, reason: 'stale-turn' });
    expect(queue.list(SESSION)[0].state).toBe('queued');
  });
});

describe('FollowupQueue claim and reservation', () => {
  it('claims the oldest queued item first (FIFO)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));

    const claimed = queue.claimNext(SESSION);

    expect(claimed.ok && claimed.item.message.ts).toBe('1.1');
    expect(claimed.ok && claimed.item.state).toBe('claimed');
  });

  it('reports an empty queue instead of claiming nothing silently', () => {
    const queue = new FollowupQueue();

    expect(queue.claimNext(SESSION)).toEqual({ ok: false, reason: 'empty' });
  });

  it('blocks drain while a Send now reservation is held', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const second = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (second.status !== 'queued') throw new Error('setup failed');

    const reserved = queue.reserve(SESSION, second.item.id, second.item.epoch, queue.getTurnEpoch(SESSION));

    expect(reserved.ok && reserved.item.state).toBe('reserved');
    expect(queue.claimNext(SESSION)).toEqual({ ok: false, reason: 'busy' });
  });

  it('rejects a competing reservation while one is held (single winner)', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    const second = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (first.status !== 'queued' || second.status !== 'queued') throw new Error('setup failed');
    queue.reserve(SESSION, first.item.id, first.item.epoch, queue.getTurnEpoch(SESSION));

    expect(queue.reserve(SESSION, second.item.id, second.item.epoch, queue.getTurnEpoch(SESSION))).toEqual({
      ok: false,
      reason: 'busy',
    });
  });

  it('rejects a double-click reservation carrying the stale epoch (A12)', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');
    const staleEpoch = first.item.epoch;
    queue.reserve(SESSION, first.item.id, staleEpoch, queue.getTurnEpoch(SESSION));
    queue.rollback(SESSION, first.item.id, queue.list(SESSION)[0].epoch, 'canInterrupt denied');

    expect(queue.reserve(SESSION, first.item.id, staleEpoch, queue.getTurnEpoch(SESSION))).toEqual({
      ok: false,
      reason: 'stale-epoch',
    });
  });

  it('promotes a reservation straight to claimed without re-claiming', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');
    const reserved = queue.reserve(SESSION, first.item.id, first.item.epoch, queue.getTurnEpoch(SESSION));
    if (!reserved.ok) throw new Error('reserve failed');

    const promoted = queue.promote(SESSION, reserved.item.id, reserved.item.epoch);

    expect(promoted.ok && promoted.item.state).toBe('claimed');
    expect(promoted.ok && promoted.item.seq).toBe(1);
  });

  it('marks a claimed item dispatched and settles it', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(queue);

    const settled = queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'tool crash');

    expect(settled.ok && settled.item.state).toBe('failed');
    expect(settled.ok && settled.item.stateReason).toBe('tool crash');
  });

  it('refuses a second dispatch while another item is still dispatched', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const second = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (second.status !== 'queued') throw new Error('setup failed');
    dispatchFirst(queue); // 1.1 running
    const reserved = queue.reserve(SESSION, second.item.id, second.item.epoch, queue.getTurnEpoch(SESSION)); // Send now, allowed
    if (!reserved.ok) throw new Error(`reserve failed: ${reserved.reason}`);
    const promoted = queue.promote(SESSION, reserved.item.id, reserved.item.epoch);
    if (!promoted.ok) throw new Error('promote failed');

    // The old turn was never torn down — §3.3 requires interrupt + teardown first.
    expect(queue.markDispatched(SESSION, promoted.item.id, promoted.item.epoch)).toEqual({
      ok: false,
      reason: 'busy',
    });
  });

  it('marks the interrupted item uncertain without freezing the queue, so Send now can proceed (A10/A11)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const second = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (second.status !== 'queued') throw new Error('setup failed');
    const running = dispatchFirst(queue);
    const reserved = queue.reserve(SESSION, second.item.id, second.item.epoch, queue.getTurnEpoch(SESSION));
    if (!reserved.ok) throw new Error('reserve failed');

    const interrupted = queue.markInterrupted(SESSION, running.id, running.epoch, 'user-interrupted');

    expect(interrupted.ok && interrupted.item.state).toBe('uncertain');
    expect(interrupted.ok && interrupted.item.stateReason).toBe('user-interrupted');
    expect(queue.freezeReason(SESSION)).toBeUndefined();
    expect(queue.list(SESSION)[1].state).toBe('reserved'); // reservation survives the interrupt

    const promoted = queue.promote(SESSION, reserved.item.id, reserved.item.epoch);
    if (!promoted.ok) throw new Error('promote failed');
    expect(queue.markDispatched(SESSION, promoted.item.id, promoted.item.epoch).ok).toBe(true);
  });

  it('refuses to mark an item interrupted when it was never dispatched', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    expect(queue.markInterrupted(SESSION, first.item.id, first.item.epoch, 'user-interrupted')).toEqual({
      ok: false,
      reason: 'invalid-state',
    });
  });

  it('settles an uncertain item to resolved once the outcome is confirmed (SSOT §3.5)', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    dispatchFirst(source);
    const queue = new FollowupQueue({ snapshot: source.snapshot() });
    queue.recover('process restart');
    const uncertain = queue.list(SESSION)[0];

    const settled = queue.settle(SESSION, uncertain.id, uncertain.epoch, 'resolved');

    expect(settled.ok && settled.item.state).toBe('resolved');
  });

  it('settles an uncertain item to failed once the outcome is confirmed (SSOT §3.5)', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    dispatchFirst(source);
    const queue = new FollowupQueue({ snapshot: source.snapshot() });
    queue.recover('process restart');
    const uncertain = queue.list(SESSION)[0];

    const settled = queue.settle(SESSION, uncertain.id, uncertain.epoch, 'failed', 'confirmed crash');

    expect(settled.ok && settled.item.state).toBe('failed');
    expect(settled.ok && settled.item.stateReason).toBe('confirmed crash');
  });

  it('rejects a late write from the superseded turn (A28)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(queue);
    queue.settle(SESSION, dispatched.id, dispatched.epoch, 'resolved');

    expect(queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed')).toEqual({
      ok: false,
      reason: 'stale-epoch',
    });
    expect(queue.list(SESSION)[0].state).toBe('resolved');
  });

  it('refuses to settle a claimed item — the state machine has no claimed → failed edge (05 §5)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const claimed = queue.claimNext(SESSION);
    if (!claimed.ok) throw new Error('claim failed');

    const settled = queue.settle(SESSION, claimed.item.id, claimed.item.epoch, 'failed', 'boom');

    expect(settled).toEqual({ ok: false, reason: 'invalid-state' });
    const stored = queue.get(SESSION, claimed.item.id);
    expect(stored?.state).toBe('claimed'); // untouched, not silently terminated
    expect(stored?.epoch).toBe(claimed.item.epoch);
  });

  it('takes a claimed item out through rollback, its only non-dispatch exit', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const claimed = queue.claimNext(SESSION);
    if (!claimed.ok) throw new Error('claim failed');

    const rolled = queue.rollback(SESSION, claimed.item.id, claimed.item.epoch, 'boom');
    if (!rolled.ok) throw new Error('rollback failed');
    const dispatched = dispatchFirst(queue);
    const settled = queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'boom');

    expect(rolled.item.seq).toBe(1); // same FIFO position
    expect(settled.ok && settled.item.state).toBe('failed');
  });

  it('rolls a claimed item back to queued with a denial reason distinct from paused (A13/A29)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const claimed = queue.claimNext(SESSION);
    if (!claimed.ok) throw new Error('claim failed');

    const rolled = queue.rollback(SESSION, claimed.item.id, claimed.item.epoch, 'authorization denied');

    expect(rolled.ok && rolled.item.state).toBe('queued');
    expect(rolled.ok && rolled.item.seq).toBe(1);
    expect(rolled.ok && rolled.item.stateReason).toBe('authorization denied');
    expect(queue.freezeReason(SESSION)).toBeUndefined();
    expect(queue.claimNext(SESSION).ok).toBe(true);
  });
});

describe('FollowupQueue freeze and resume', () => {
  it('freezes queued/reserved/claimed to paused and dispatched to uncertain (A17/A31)', () => {
    const queue = new FollowupQueue();
    for (const ts of ['1.1', '1.2', '1.3', '1.4']) queue.enqueue(SESSION, event({ ts }));
    const dispatched = dispatchFirst(queue); // 1.1 -> dispatched
    const second = queue.list(SESSION)[1];
    queue.reserve(SESSION, second.id, second.epoch, queue.getTurnEpoch(SESSION)); // 1.2 -> reserved

    queue.freeze(SESSION, 'stop pressed');

    const byTs = Object.fromEntries(queue.list(SESSION).map((item) => [item.message.ts, item.state]));
    expect(byTs).toEqual({ '1.1': 'uncertain', '1.2': 'paused', '1.3': 'paused', '1.4': 'paused' });
    expect(queue.get(SESSION, dispatched.id)?.state).toBe('uncertain');
    expect(queue.freezeReason(SESSION)).toBe('stop pressed');
  });

  it('freezes a claimed-but-not-started item to paused, not uncertain (A31)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    const claimed = queue.claimNext(SESSION); // claimed, never dispatched
    if (!claimed.ok) throw new Error('claim failed');

    queue.freeze(SESSION, 'stop pressed');

    const byTs = Object.fromEntries(queue.list(SESSION).map((item) => [item.message.ts, item.state]));
    expect(byTs).toEqual({ '1.1': 'paused', '1.2': 'paused' });
  });

  it('blocks drain until an explicit resume', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'security ASK pending');

    expect(queue.claimNext(SESSION)).toEqual({ ok: false, reason: 'frozen' });

    queue.resume(SESSION);

    expect(queue.claimNext(SESSION).ok).toBe(true);
    expect(queue.freezeReason(SESSION)).toBeUndefined();
  });

  it('keeps accepting new messages while frozen without reviving paused items (A27)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'stop pressed');

    const fresh = queue.enqueue(SESSION, event({ ts: '1.2' }));

    expect(fresh.status).toBe('queued');
    expect(queue.list(SESSION)[0].state).toBe('paused');
  });

  it('revives only paused items on resume', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    const dispatched = dispatchFirst(queue);
    queue.settle(SESSION, dispatched.id, dispatched.epoch, 'resolved');
    queue.freeze(SESSION, 'stop pressed');

    queue.resume(SESSION);

    const byTs = Object.fromEntries(queue.list(SESSION).map((item) => [item.message.ts, item.state]));
    expect(byTs).toEqual({ '1.1': 'resolved', '1.2': 'queued' });
  });
});

describe('FollowupQueue restart recovery', () => {
  it('downgrades queued and reserved to paused and leaves a confirmed failed alone (A16)', () => {
    const source = new FollowupQueue();
    for (const ts of ['1.1', '1.2', '1.3', '1.4']) source.enqueue(SESSION, event({ ts }));
    const dispatched = dispatchFirst(source); // 1.1 -> dispatched
    const second = source.list(SESSION)[1];
    source.reserve(SESSION, second.id, second.epoch, source.getTurnEpoch(SESSION)); // 1.2 -> reserved
    source.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'crashed');
    expect(source.list(SESSION)[2].state).toBe('queued'); // 1.3 untouched

    const restarted = new FollowupQueue({ snapshot: source.snapshot() });
    restarted.recover('process restart');

    const byTs = Object.fromEntries(restarted.list(SESSION).map((item) => [item.message.ts, item.state]));
    expect(byTs).toEqual({ '1.1': 'failed', '1.2': 'paused', '1.3': 'paused', '1.4': 'paused' });
  });

  it('marks a claimed-but-not-started item uncertain on restart, not paused (SSOT §3.5 / A16)', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    source.enqueue(SESSION, event({ ts: '1.2' }));
    const claimed = source.claimNext(SESSION); // claimed, never dispatched
    if (!claimed.ok) throw new Error('claim failed');

    const restarted = new FollowupQueue({ snapshot: source.snapshot() });
    restarted.recover('process restart');

    // A restart cannot prove the claim never produced a query — unlike stop,
    // which observes the un-started claim directly.
    const byTs = Object.fromEntries(restarted.list(SESSION).map((item) => [item.message.ts, item.state]));
    expect(byTs).toEqual({ '1.1': 'uncertain', '1.2': 'paused' });
  });

  it('marks an interrupted in-flight item uncertain and never replays it automatically', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    dispatchFirst(source);

    const restarted = new FollowupQueue({ snapshot: source.snapshot() });
    restarted.recover('process restart');

    expect(restarted.list(SESSION)[0].state).toBe('uncertain');
    expect(restarted.claimNext(SESSION)).toEqual({ ok: false, reason: 'frozen' });
    expect(restarted.freezeReason(SESSION)).toBe('process restart');
  });

  it('leaves a session whose queue is only history unfrozen — there is nothing to protect', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(source);
    source.settle(SESSION, dispatched.id, dispatched.epoch, 'resolved');
    source.enqueue(OTHER_SESSION, event({ ts: '2.1' })); // still queued → must freeze

    const restarted = new FollowupQueue({ snapshot: source.snapshot() });
    restarted.recover('process restart');

    // A freeze exists to hold items back. A session that has none holds nothing
    // back — freezing it only makes the next message wait for a Resume the user
    // has no reason to press.
    expect(restarted.freezeReason(SESSION)).toBeUndefined();
    expect(restarted.list(SESSION)[0].state).toBe('resolved');
    expect(restarted.freezeReason(OTHER_SESSION)).toBe('process restart');
    expect(restarted.list(OTHER_SESSION)[0].state).toBe('paused');
  });

  it('clears a stale freeze a previous restart left on a session with nothing parked', () => {
    // Snapshots written by the pre-scope build carry `freeze` on history-only
    // sessions. A freeze with no paused/uncertain row holds nothing back, so a
    // recover must drop it instead of carrying the stale banner forward.
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(source);
    source.settle(SESSION, dispatched.id, dispatched.epoch, 'resolved');
    const snapshot = source.snapshot();
    const row = snapshot.sessions.find((session) => session.sessionKey === SESSION);
    if (!row) throw new Error('session missing');
    row.freeze = { reason: 'process restart', at: Date.now() - 1000 };

    const restarted = new FollowupQueue({ snapshot });
    restarted.recover('process restart');

    expect(restarted.freezeReason(SESSION)).toBeUndefined();
    expect(restarted.enqueue(SESSION, event({ ts: '1.2' })).status).toBe('queued');
    expect(restarted.claimNext(SESSION).ok).toBe(true);
  });

  it('leaves a session with no items at all unfrozen', () => {
    const source = new FollowupQueue();
    source.beginTurn(SESSION); // a turn generation creates the session row, with no items

    const restarted = new FollowupQueue({ snapshot: source.snapshot() });
    restarted.recover('process restart');

    expect(restarted.freezeReason(SESSION)).toBeUndefined();
    expect(restarted.enqueue(SESSION, event({ ts: '1.1' })).status).toBe('queued');
    expect(restarted.claimNext(SESSION).ok).toBe(true); // drains without a Resume
  });
});

/**
 * A freeze parks the items that were ALREADY in the session when it happened.
 * A message the user sends AFTER that is not one of them: it was never at risk
 * of being blind-replayed, and holding it back is the conflation A29 forbids
 * (a live message and a restored one never share a sentence).
 *
 * The discriminator is the STATE, not a timestamp: the freeze rewrites every
 * pre-freeze non-terminal row to `paused`/`uncertain`, so a `queued` row in a
 * frozen session can only be one that arrived after it.
 */
describe('FollowupQueue freeze scope — items that arrive after the freeze', () => {
  it('steers a message enqueued after the freeze into the live turn', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'stop pressed');
    const fresh = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (fresh.status !== 'queued') throw new Error('setup failed');

    const steered = queue.steer(SESSION, fresh.item.id, fresh.item.epoch, 'uuid-1');

    expect(steered.ok && steered.item.state).toBe('steered');
    expect(queue.list(SESSION)[0].state).toBe('paused'); // the parked row is untouched
    expect(queue.freezeReason(SESSION)).toBe('stop pressed');
  });

  it('claims a message enqueued after the freeze and leaves the paused ones alone', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'process restart');
    queue.enqueue(SESSION, event({ ts: '1.2' }));

    const claimed = queue.claimNext(SESSION);

    expect(claimed.ok && claimed.item.message.ts).toBe('1.2');
    expect(queue.list(SESSION)[0].state).toBe('paused');
    expect(queue.freezeReason(SESSION)).toBe('process restart');
  });

  it('still answers `frozen` when the only items are the ones the freeze parked', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'stop pressed');

    expect(queue.claimNext(SESSION)).toEqual({ ok: false, reason: 'frozen' });
  });

  it('reserves a `Send now` on a message enqueued after the freeze', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'stop pressed');
    const fresh = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (fresh.status !== 'queued') throw new Error('setup failed');

    const reserved = queue.reserve(SESSION, fresh.item.id, fresh.item.epoch, queue.getTurnEpoch(SESSION));

    expect(reserved.ok && reserved.item.state).toBe('reserved');
  });

  it('exports the parked states, so the renderer scopes a freeze the same way the gates do', () => {
    expect([...FREEZE_PARKED_STATES]).toEqual(['paused', 'uncertain']);
  });
});

/**
 * A freeze is exactly the rows it parked. Once the last one leaves — resumed,
 * retried, or cancelled — the session holds nothing back, and a `freeze` that
 * outlives its rows is a banner the user cannot clear and a `frozen` answer for
 * a queue that has only ordinary work left.
 */
describe('FollowupQueue freeze settlement — the freeze dies with its last parked row', () => {
  it('unfreezes when the only paused row is cancelled', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'stop pressed');
    const paused = queue.list(SESSION)[0];

    const cancelled = queue.cancelItem(SESSION, paused.id, paused.epoch, '필요 없어짐');

    expect(cancelled.ok && cancelled.item.state).toBe('cancelled');
    expect(queue.freezeReason(SESSION)).toBeUndefined();
  });

  it('unfreezes when the only uncertain row is retried', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    dispatchFirst(source);
    const queue = new FollowupQueue({ snapshot: source.snapshot() });
    queue.recover('process restart');
    const uncertain = queue.list(SESSION)[0];

    const retried = queue.retry(SESSION, uncertain.id, uncertain.epoch);

    expect(retried.ok && retried.item.state).toBe('queued');
    expect(queue.freezeReason(SESSION)).toBeUndefined();
    expect(queue.claimNext(SESSION).ok).toBe(true); // and it drains without a Resume
  });

  it('stays frozen while another parked row is still waiting', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    queue.freeze(SESSION, 'stop pressed');
    const [first] = queue.list(SESSION);

    queue.cancelItem(SESSION, first.id, first.epoch, '필요 없어짐');

    expect(queue.freezeReason(SESSION)).toBe('stop pressed');
    expect(queue.list(SESSION)[1].state).toBe('paused');
  });

  it('unfreezes a session whose parked rows were all cancelled at once', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    queue.freeze(SESSION, 'stop pressed');

    queue.cancelSession(SESSION, 'session deleted');

    expect(queue.freezeReason(SESSION)).toBeUndefined();
    expect(queue.list(SESSION).map((item) => item.state)).toEqual(['cancelled', 'cancelled']);
  });

  it('leaves a post-freeze queued row alone when the last parked row leaves', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'stop pressed');
    queue.enqueue(SESSION, event({ ts: '1.2' })); // arrived after the freeze — ordinary work
    const paused = queue.list(SESSION)[0];

    queue.cancelItem(SESSION, paused.id, paused.epoch);

    expect(queue.freezeReason(SESSION)).toBeUndefined();
    expect(queue.list(SESSION)[1].state).toBe('queued'); // untouched by the settlement
  });
});

describe('FollowupQueue cancel and retry', () => {
  it('cancels every non-terminal item of a session but keeps history (A18)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    const dispatched = dispatchFirst(queue);
    queue.settle(SESSION, dispatched.id, dispatched.epoch, 'resolved');

    queue.cancelSession(SESSION, 'session deleted');

    const byTs = Object.fromEntries(queue.list(SESSION).map((item) => [item.message.ts, item.state]));
    expect(byTs).toEqual({ '1.1': 'resolved', '1.2': 'cancelled' });
    expect(queue.list(SESSION)[1].stateReason).toBe('session deleted');
  });

  it('requeues a failed item only on explicit retry', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(queue);
    const failed = queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'tool crash');
    if (!failed.ok) throw new Error('settle failed');

    const retried = queue.retry(SESSION, failed.item.id, failed.item.epoch);

    expect(retried.ok && retried.item.state).toBe('queued');
    expect(retried.ok && retried.item.seq).toBe(1);
  });

  it('requeues an uncertain item only on explicit retry, after the session was resumed', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    dispatchFirst(source);
    const queue = new FollowupQueue({ snapshot: source.snapshot() });
    queue.recover('process restart');
    queue.resume(SESSION);
    const uncertain = queue.list(SESSION)[0];

    const retried = queue.retry(SESSION, uncertain.id, uncertain.epoch);

    expect(retried.ok && retried.item.state).toBe('queued');
  });

  /**
   * Retry IS the explicit user decision a freeze waits for (A16/A17): the click
   * lands on the parked row itself and says "run this one". Refusing it until a
   * separate Resume made the panel's own Retry control a dead end — the freeze
   * scope is per item (`FREEZE_PARKED_STATES`), so there is no session-level
   * lock left for a retry to break.
   */
  it('retries an uncertain item the freeze parked — the click is the decision', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    source.enqueue(SESSION, event({ ts: '1.2' }));
    dispatchFirst(source);
    const queue = new FollowupQueue({ snapshot: source.snapshot() });
    queue.recover('process restart');
    const uncertain = queue.list(SESSION)[0];

    const retried = queue.retry(SESSION, uncertain.id, uncertain.epoch);

    expect(retried.ok && retried.item.state).toBe('queued');
    expect(retried.ok && retried.item.seq).toBe(1); // FIFO position kept
    // The OTHER parked row still holds the freeze open — one retry is not a resume.
    expect(queue.list(SESSION)[1].state).toBe('paused');
    expect(queue.freezeReason(SESSION)).toBe('process restart');
  });

  it('retries a confirmed failure while the session is frozen', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    const dispatched = dispatchFirst(queue);
    const failed = queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'tool crash');
    if (!failed.ok) throw new Error('settle failed');
    queue.freeze(SESSION, 'stop pressed'); // 1.2 → paused, the failure stays failed

    const retried = queue.retry(SESSION, failed.item.id, failed.item.epoch);

    expect(retried.ok && retried.item.state).toBe('queued');
  });

  it('still refuses retry for a state that has no retry edge, frozen or not', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'stop pressed');
    const paused = queue.list(SESSION)[0];

    expect(queue.retry(SESSION, paused.id, paused.epoch)).toEqual({ ok: false, reason: 'invalid-state' });
    expect(queue.list(SESSION)[0].state).toBe('paused');
  });

  it('keeps a confirmed failure out of session cancellation (ssot.md:157)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    const dispatched = dispatchFirst(queue);
    queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'tool crash');

    queue.cancelSession(SESSION, 'session deleted');

    const byTs = Object.fromEntries(queue.list(SESSION).map((item) => [item.message.ts, item.state]));
    expect(byTs).toEqual({ '1.1': 'failed', '1.2': 'cancelled' });
    expect(queue.list(SESSION)[0].stateReason).toBe('tool crash'); // failure history survives
  });

  it('refuses retry for an item that is not failed or uncertain', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    expect(queue.retry(SESSION, first.item.id, first.item.epoch)).toEqual({ ok: false, reason: 'invalid-state' });
  });

  it('refuses to retry a failed item back over the capacity ceiling', () => {
    const queue = new FollowupQueue({ capacity: 2 });
    const failedIds: string[] = [];
    for (const ts of ['1.1', '1.2']) {
      queue.enqueue(SESSION, event({ ts }));
      const dispatched = dispatchFirst(queue);
      const settled = queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'tool crash');
      if (!settled.ok) throw new Error('settle failed');
      failedIds.push(settled.item.id);
    }
    queue.enqueue(SESSION, event({ ts: '1.3' }));
    queue.enqueue(SESSION, event({ ts: '1.4' })); // pending is now 2 = capacity
    const failed = queue.get(SESSION, failedIds[0]);
    if (!failed) throw new Error('setup failed');

    expect(queue.retry(SESSION, failed.id, failed.epoch)).toEqual({ ok: false, reason: 'capacity' });

    const unchanged = queue.get(SESSION, failed.id);
    expect(unchanged?.state).toBe('failed');
    expect(unchanged?.stateReason).toBe('tool crash');
    expect(unchanged?.epoch).toBe(failed.epoch);
  });

  it('retries an uncertain item even at capacity, because it already holds its slot', () => {
    const queue = new FollowupQueue({ capacity: 2 });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    const running = dispatchFirst(queue);
    const interrupted = queue.markInterrupted(SESSION, running.id, running.epoch, 'user-interrupted');
    if (!interrupted.ok) throw new Error('markInterrupted failed'); // pending is 2 = capacity

    const retried = queue.retry(SESSION, interrupted.item.id, interrupted.item.epoch);

    expect(retried.ok && retried.item.state).toBe('queued');
  });

  it('reports an unknown item instead of throwing', () => {
    const queue = new FollowupQueue();

    expect(queue.reserve(SESSION, 'nope', 0, queue.getTurnEpoch(SESSION))).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('FollowupQueue cancelItem (per-item Cancel from the Queue panel)', () => {
  it('cancels a queued item with the default reason and keeps it as history', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    const cancelled = queue.cancelItem(SESSION, first.item.id, first.item.epoch);

    expect(cancelled.ok && cancelled.item.state).toBe('cancelled');
    expect(cancelled.ok && cancelled.item.stateReason).toBe(FOLLOWUP_CANCEL_DEFAULT_REASON);
    expect(queue.list(SESSION)).toHaveLength(1); // history, not a deletion
    expect(queue.list(SESSION)[0].seq).toBe(1);
  });

  it('falls back to the default reason when the caller supplies a blank one', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    // A blank reason is a MISSING reason: storing it would leave the panel's
    // history line saying only `cancelled`, with nothing about who or why.
    const cancelled = queue.cancelItem(SESSION, first.item.id, first.item.epoch, '   ');
    const blank = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (blank.status !== 'queued') throw new Error('setup failed');
    const empty = queue.cancelItem(SESSION, blank.item.id, blank.item.epoch, '');

    expect(cancelled.ok && cancelled.item.stateReason).toBe(FOLLOWUP_CANCEL_DEFAULT_REASON);
    expect(empty.ok && empty.item.stateReason).toBe(FOLLOWUP_CANCEL_DEFAULT_REASON);
  });

  it('records an explicit reason when the caller supplies one', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    const cancelled = queue.cancelItem(SESSION, first.item.id, first.item.epoch, '중복 요청');

    expect(cancelled.ok && cancelled.item.stateReason).toBe('중복 요청');
  });

  it('cancels a paused item while the session is frozen, without resuming anything else', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    queue.freeze(SESSION, 'stop pressed');
    const paused = queue.list(SESSION)[0];

    const cancelled = queue.cancelItem(SESSION, paused.id, paused.epoch);

    expect(cancelled.ok && cancelled.item.state).toBe('cancelled');
    expect(queue.list(SESSION)[1].state).toBe('paused'); // the freeze is untouched
    expect(queue.freezeReason(SESSION)).toBe('stop pressed');
  });

  it('cancels a confirmed failed item, replacing its history reason', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const dispatched = dispatchFirst(queue);
    const failed = queue.settle(SESSION, dispatched.id, dispatched.epoch, 'failed', 'tool crash');
    if (!failed.ok) throw new Error('settle failed');

    const cancelled = queue.cancelItem(SESSION, failed.item.id, failed.item.epoch, '재시도 안 함');

    expect(cancelled.ok && cancelled.item.state).toBe('cancelled');
    expect(cancelled.ok && cancelled.item.stateReason).toBe('재시도 안 함');
  });

  it('cancels an uncertain item so an unknown outcome can be closed without a replay', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    dispatchFirst(source);
    const queue = new FollowupQueue({ snapshot: source.snapshot() });
    queue.recover('process restart');
    const uncertain = queue.list(SESSION)[0];

    const cancelled = queue.cancelItem(SESSION, uncertain.id, uncertain.epoch);

    expect(cancelled.ok && cancelled.item.state).toBe('cancelled');
  });

  it.each([
    'reserved',
    'claimed',
    'dispatched',
  ] as const)('refuses to cancel an in-flight %s item — a running turn is never aborted from here', (state) => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');
    if (state === 'reserved') {
      queue.reserve(SESSION, first.item.id, first.item.epoch, queue.getTurnEpoch(SESSION));
    } else if (state === 'claimed') {
      queue.claimNext(SESSION);
    } else {
      dispatchFirst(queue);
    }
    const inFlight = queue.list(SESSION)[0];
    expect(inFlight.state).toBe(state);

    expect(queue.cancelItem(SESSION, inFlight.id, inFlight.epoch)).toEqual({ ok: false, reason: 'invalid-state' });

    const unchanged = queue.get(SESSION, inFlight.id);
    expect(unchanged?.state).toBe(state);
    expect(unchanged?.epoch).toBe(inFlight.epoch); // untouched, not silently bumped
  });

  it.each(['resolved', 'cancelled'] as const)('refuses to cancel an already terminal %s item', (state) => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');
    if (state === 'resolved') {
      const dispatched = dispatchFirst(queue);
      queue.settle(SESSION, dispatched.id, dispatched.epoch, 'resolved');
    } else {
      queue.cancelItem(SESSION, first.item.id, first.item.epoch);
    }
    const terminal = queue.list(SESSION)[0];
    expect(terminal.state).toBe(state);

    expect(queue.cancelItem(SESSION, terminal.id, terminal.epoch)).toEqual({ ok: false, reason: 'invalid-state' });
    expect(queue.get(SESSION, terminal.id)?.stateReason).toBe(terminal.stateReason);
  });

  it('rejects a double-clicked Cancel carrying the stale epoch (A12)', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');
    const staleEpoch = first.item.epoch;
    queue.cancelItem(SESSION, first.item.id, staleEpoch);

    expect(queue.cancelItem(SESSION, first.item.id, staleEpoch)).toEqual({ ok: false, reason: 'stale-epoch' });
  });

  it('reports an unknown item instead of throwing', () => {
    const queue = new FollowupQueue();

    expect(queue.cancelItem(SESSION, 'nope', 0)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('persists the cancellation before it is visible in memory', () => {
    const seen: FollowupQueueSnapshot[] = [];
    let failing = false;
    const queue = new FollowupQueue({
      save: (snapshot) => {
        if (failing) throw new Error('disk full');
        seen.push(snapshot);
      },
    });
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    const second = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (first.status !== 'queued' || second.status !== 'queued') throw new Error('setup failed');

    queue.cancelItem(SESSION, first.item.id, first.item.epoch);
    expect(seen[seen.length - 1].sessions[0].items[0].state).toBe('cancelled');

    failing = true;
    expect(() => queue.cancelItem(SESSION, second.item.id, second.item.epoch)).toThrow('disk full');
    expect(queue.get(SESSION, second.item.id)?.state).toBe('queued'); // committed memory never moved
  });

  it('frees a capacity slot, exactly like a confirmed failure does (ssot.md:157 terminal set)', () => {
    const queue = new FollowupQueue({ capacity: 1 });
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');
    expect(queue.enqueue(SESSION, event({ ts: '1.2' })).status).toBe('capacity');

    queue.cancelItem(SESSION, first.item.id, first.item.epoch);

    expect(queue.enqueue(SESSION, event({ ts: '1.2' })).status).toBe('queued');
  });

  it('leaves a cancelled item out of session cancellation and of retry', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');
    const cancelled = queue.cancelItem(SESSION, first.item.id, first.item.epoch, '사용자 취소');
    if (!cancelled.ok) throw new Error('cancelItem failed');

    queue.cancelSession(SESSION, 'session deleted');

    expect(queue.get(SESSION, first.item.id)?.stateReason).toBe('사용자 취소'); // own history survives
    expect(queue.retry(SESSION, cancelled.item.id, cancelled.item.epoch)).toEqual({
      ok: false,
      reason: 'invalid-state',
    });
  });
});

describe('FollowupQueue auto-steering (06 §3.2)', () => {
  it('moves a queued item to steered and records the SDK uuid it was pushed under', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    const steered = queue.steer(SESSION, first.item.id, first.item.epoch, 'uuid-abc');

    expect(steered.ok && steered.item.state).toBe('steered');
    expect(steered.ok && steered.item.steerUuid).toBe('uuid-abc');
    expect(steered.ok && steered.item.stateReason).toBe('steered');
    expect(steered.ok && steered.item.seq).toBe(1); // FIFO position is not spent
    expect(steered.ok && steered.item.epoch).toBe(first.item.epoch + 1);
  });

  it('persists the steer BEFORE it is visible in memory, so a push can never precede its row', () => {
    const seen: FollowupQueueSnapshot[] = [];
    let failing = false;
    const queue = new FollowupQueue({
      save: (snapshot) => {
        if (failing) throw new Error('disk full');
        seen.push(snapshot);
      },
    });
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    const second = queue.enqueue(SESSION, event({ ts: '1.2' }));
    if (first.status !== 'queued' || second.status !== 'queued') throw new Error('setup failed');

    queue.steer(SESSION, first.item.id, first.item.epoch, 'uuid-1');
    expect(seen[seen.length - 1].sessions[0].items[0].state).toBe('steered');

    failing = true;
    expect(() => queue.steer(SESSION, second.item.id, second.item.epoch, 'uuid-2')).toThrow('disk full');
    expect(queue.get(SESSION, second.item.id)?.state).toBe('queued');
    expect(queue.get(SESSION, second.item.id)?.steerUuid).toBeUndefined();
  });

  it('refuses to steer an item the freeze parked — it waits for an explicit resume (A17/A29)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.freeze(SESSION, 'stop pressed');
    const paused = queue.list(SESSION)[0];

    expect(queue.steer(SESSION, paused.id, paused.epoch, 'uuid-1')).toEqual({ ok: false, reason: 'frozen' });
    expect(queue.get(SESSION, paused.id)?.epoch).toBe(paused.epoch); // untouched
  });

  it('rejects a steer carrying a stale item epoch (A12)', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');
    const staleEpoch = first.item.epoch;
    queue.steer(SESSION, first.item.id, staleEpoch, 'uuid-1');
    queue.unsteer(SESSION, 'uuid-1', 'turn ended unread');

    expect(queue.steer(SESSION, first.item.id, staleEpoch, 'uuid-2')).toEqual({ ok: false, reason: 'stale-epoch' });
  });

  it('refuses to steer an item that is not queued, so one message is never pushed twice', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const steered = steerFirst(queue);

    expect(queue.steer(SESSION, steered.id, steered.epoch, 'uuid-2')).toEqual({ ok: false, reason: 'invalid-state' });
    expect(queue.get(SESSION, steered.id)?.steerUuid).toBe('uuid-1');
  });

  it('reports an unknown item instead of throwing', () => {
    const queue = new FollowupQueue();

    expect(queue.steer(SESSION, 'nope', 0, 'uuid-1')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('FollowupQueue steer settlement (consumed / unsteer)', () => {
  it('resolves a steered item on the SDK consumption receipt, as history that frees its slot', () => {
    const queue = new FollowupQueue({ capacity: 1 });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const steered = steerFirst(queue, 'uuid-abc');
    expect(queue.enqueue(SESSION, event({ ts: '1.2' })).status).toBe('capacity'); // steered still occupies it

    const consumed = queue.markConsumed(SESSION, 'uuid-abc');

    expect(consumed.ok && consumed.item.id).toBe(steered.id);
    expect(consumed.ok && consumed.item.state).toBe('resolved');
    expect(consumed.ok && consumed.item.stateReason).toBe('consumed');
    expect(queue.list(SESSION)).toHaveLength(1); // history is kept
    expect(queue.enqueue(SESSION, event({ ts: '1.2' })).status).toBe('queued');
  });

  it('reports not-found for a uuid no item carries', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    steerFirst(queue, 'uuid-1');

    expect(queue.markConsumed(SESSION, 'uuid-other')).toEqual({ ok: false, reason: 'not-found' });
    expect(queue.markConsumed('C1:nope', 'uuid-1')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('answers invalid-state — not not-found — when the same receipt is delivered twice', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    steerFirst(queue, 'uuid-1');
    const first = queue.markConsumed(SESSION, 'uuid-1');
    if (!first.ok) throw new Error('markConsumed failed');

    expect(queue.markConsumed(SESSION, 'uuid-1')).toEqual({ ok: false, reason: 'invalid-state' });
    expect(queue.get(SESSION, first.item.id)?.epoch).toBe(first.item.epoch); // untouched, not re-settled
  });

  it('returns an unread item to queued at its original seq and drops the uuid (S3)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    steerFirst(queue, 'uuid-1');

    const unsteered = queue.unsteer(SESSION, 'uuid-1', '턴이 먼저 종료됨');

    expect(unsteered.ok && unsteered.item.state).toBe('queued');
    expect(unsteered.ok && unsteered.item.seq).toBe(1);
    expect(unsteered.ok && unsteered.item.stateReason).toBe('턴이 먼저 종료됨');
    expect(unsteered.ok && unsteered.item.steerUuid).toBeUndefined();
    // FIFO order is intact: the returned item is still the next claim.
    expect(queue.claimNext(SESSION).ok && queue.list(SESSION)[0].state).toBe('claimed');
    expect(queue.list(SESSION)[1].state).toBe('queued');
  });

  it('cannot be settled twice by the same uuid once unsteered — the handle is gone', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    steerFirst(queue, 'uuid-1');
    queue.unsteer(SESSION, 'uuid-1', 'turn ended unread');

    expect(queue.markConsumed(SESSION, 'uuid-1')).toEqual({ ok: false, reason: 'not-found' });
    expect(queue.unsteer(SESSION, 'uuid-1', 'again')).toEqual({ ok: false, reason: 'not-found' });
    expect(queue.list(SESSION)[0].state).toBe('queued');
  });
});

describe('FollowupQueue steered items and the drain', () => {
  it('never claims a steered item — the running turn already has it', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    steerFirst(queue);

    expect(queue.claimNext(SESSION)).toEqual({ ok: false, reason: 'empty' });
  });

  it('does not block the claim of a queued sibling (a steered item is not in flight)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    steerFirst(queue);

    const claimed = queue.claimNext(SESSION);

    expect(claimed.ok && claimed.item.message.ts).toBe('1.2');
    expect(queue.list(SESSION)[0].state).toBe('steered'); // untouched by the drain
  });

  it('keeps counting a steered item against capacity (it is not terminal)', () => {
    const queue = new FollowupQueue({ capacity: 2 });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    steerFirst(queue);

    expect(queue.enqueue(SESSION, event({ ts: '1.3' }))).toEqual({ status: 'capacity', capacity: 2, pending: 2 });
  });
});

describe('FollowupQueue steered items under freeze and restart', () => {
  it('marks a steered item uncertain on stop and clears the uuid — nobody saw whether it was read', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const steered = steerFirst(queue, 'uuid-1');

    // The stop runs synchronously, BEFORE the turn's settlement frame: at this
    // instant the model may already have read the pushed message.
    queue.freeze(SESSION, 'stop pressed');

    const stopped = queue.get(SESSION, steered.id);
    expect(stopped?.state).toBe('uncertain');
    expect(stopped?.stateReason).toBe('stop pressed');
    expect(stopped?.steerUuid).toBeUndefined();
    // A receipt arriving after the stop names nothing — it cannot revive the row.
    expect(queue.markConsumed(SESSION, 'uuid-1')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('never auto-replays a stopped steer: resume leaves it uncertain, only retry requeues it (A16)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const steered = steerFirst(queue, 'uuid-1');
    queue.freeze(SESSION, 'stop pressed');

    queue.resume(SESSION);

    const resumed = queue.get(SESSION, steered.id);
    expect(resumed?.state).toBe('uncertain');
    expect(queue.claimNext(SESSION)).toEqual({ ok: false, reason: 'empty' }); // not drainable by itself
    // The explicit user decision is the only door back into the lane.
    const retried = queue.retry(SESSION, steered.id, resumed?.epoch ?? 0);
    expect(retried.ok && retried.item.state).toBe('queued');
    expect(queue.claimNext(SESSION).ok).toBe(true);
  });

  it('restores a steered item as paused after a restart, with the doubt in its reason (S7/A16)', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    source.enqueue(SESSION, event({ ts: '1.2' }));
    steerFirst(source, 'uuid-1');
    expect(source.list(SESSION)[0].state).toBe('steered');

    const restarted = new FollowupQueue({ snapshot: source.snapshot() });
    restarted.recover('재시작');

    const byTs = Object.fromEntries(restarted.list(SESSION).map((item) => [item.message.ts, item.state]));
    expect(byTs).toEqual({ '1.1': 'paused', '1.2': 'paused' });
    expect(restarted.list(SESSION)[0].steerUuid).toBeUndefined();
    // `paused` says the message cannot still run; it must not also claim the
    // model never read it before the process died.
    expect(restarted.list(SESSION)[0].stateReason).toBe('재시작 — 모델이 읽었는지 미확인');
    expect(restarted.list(SESSION)[1].stateReason).toBe('재시작');
  });

  it('brings a restart-paused steered item back to queued on resume, with no uuid attached', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    steerFirst(source, 'uuid-1');
    const queue = new FollowupQueue({ snapshot: source.snapshot() });
    queue.recover('process restart');

    queue.resume(SESSION);

    expect(queue.list(SESSION)[0].state).toBe('queued');
    expect(queue.list(SESSION)[0].steerUuid).toBeUndefined();
    expect(queue.claimNext(SESSION).ok).toBe(true);
  });
});

describe('FollowupQueue unsteerAll (end-of-turn sweep)', () => {
  it('returns every steered item of the session to queued, uuid cleared, in one commit', () => {
    const saved: FollowupQueueSnapshot[] = [];
    const queue = new FollowupQueue({ save: (snapshot) => saved.push(snapshot) });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    const first = steerFirst(queue, 'uuid-1');
    const second = steerFirst(queue, 'uuid-2');
    const writes = saved.length;

    const moved = queue.unsteerAll(SESSION, '턴 종료 — 수신 확인 없음');

    expect(moved.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(moved.every((item) => item.state === 'queued')).toBe(true);
    expect(moved.every((item) => item.steerUuid === undefined)).toBe(true);
    expect(queue.list(SESSION).map((item) => item.stateReason)).toEqual([
      '턴 종료 — 수신 확인 없음',
      '턴 종료 — 수신 확인 없음',
    ]);
    // One transaction for the whole sweep: a half-written sweep would leave a
    // row addressable by a uuid no receipt can arrive for.
    expect(saved.length).toBe(writes + 1);
    // Both are drainable again, at their original FIFO positions.
    expect(queue.claimNext(SESSION).ok).toBe(true);
    expect(queue.list(SESSION).map((item) => item.seq)).toEqual([1, 2]);
  });

  it('leaves every non-steered item alone and writes nothing when there is none', () => {
    const saved: FollowupQueueSnapshot[] = [];
    const queue = new FollowupQueue({ save: (snapshot) => saved.push(snapshot) });
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    const steered = steerFirst(queue, 'uuid-1');
    const dispatched = dispatchFirst(queue);
    const untouched = queue.get(SESSION, dispatched.id);
    const writes = saved.length;

    const moved = queue.unsteerAll(SESSION, 'turn ended');

    expect(moved.map((item) => item.id)).toEqual([steered.id]);
    expect(queue.get(SESSION, dispatched.id)).toEqual(untouched); // no epoch bump, no reason rewrite
    // A second sweep is a no-op: nothing steered, nothing persisted.
    expect(queue.unsteerAll(SESSION, 'turn ended')).toEqual([]);
    expect(saved.length).toBe(writes + 1);
    expect(queue.unsteerAll('C9:0.0', 'turn ended')).toEqual([]); // unknown session
  });

  it('does not reach into another session', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(OTHER_SESSION, event({ ts: '1.2' }));
    steerFirst(queue, 'uuid-1');
    const other = queue.list(OTHER_SESSION)[0];
    const otherSteered = queue.steer(OTHER_SESSION, other.id, other.epoch, 'uuid-2');
    if (!otherSteered.ok) throw new Error('setup failed');

    queue.unsteerAll(SESSION, 'turn ended');

    expect(queue.list(SESSION)[0].state).toBe('queued');
    expect(queue.list(OTHER_SESSION)[0].state).toBe('steered');
    expect(queue.list(OTHER_SESSION)[0].steerUuid).toBe('uuid-2');
  });
});

describe('FollowupQueue cancelSteered (06 §3.4)', () => {
  it('refuses a plain Cancel on a steered item — this queue cannot dequeue the SDK copy', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const steered = steerFirst(queue, 'uuid-1');

    expect(queue.cancelItem(SESSION, steered.id, steered.epoch)).toEqual({ ok: false, reason: 'invalid-state' });

    const unchanged = queue.get(SESSION, steered.id);
    expect(unchanged?.state).toBe('steered');
    expect(unchanged?.epoch).toBe(steered.epoch);
    expect(unchanged?.steerUuid).toBe('uuid-1');
  });

  it('cancels a steered item once the SDK confirmed the dequeue, clearing the uuid', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const steered = steerFirst(queue, 'uuid-1');

    const cancelled = queue.cancelSteered(SESSION, steered.id, steered.epoch, '사용자가 취소했습니다 (SDK 확인)');

    expect(cancelled.ok && cancelled.item.state).toBe('cancelled');
    expect(cancelled.ok && cancelled.item.stateReason).toBe('사용자가 취소했습니다 (SDK 확인)');
    expect(cancelled.ok && cancelled.item.steerUuid).toBeUndefined();
    expect(queue.list(SESSION)).toHaveLength(1); // history
  });

  it('falls back to the shared default reason and rejects a stale epoch', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    const steered = steerFirst(queue, 'uuid-1');

    expect(queue.cancelSteered(SESSION, steered.id, steered.epoch - 1)).toEqual({ ok: false, reason: 'stale-epoch' });
    const cancelled = queue.cancelSteered(SESSION, steered.id, steered.epoch);
    expect(cancelled.ok && cancelled.item.stateReason).toBe(FOLLOWUP_CANCEL_DEFAULT_REASON);
  });

  it('refuses any state other than steered, so it can never stand in for cancelItem', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    expect(queue.cancelSteered(SESSION, first.item.id, first.item.epoch)).toEqual({
      ok: false,
      reason: 'invalid-state',
    });
    expect(queue.get(SESSION, first.item.id)?.state).toBe('queued');
  });

  it('cancels a steered item along with the rest of a deleted session (A18)', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1' }));
    queue.enqueue(SESSION, event({ ts: '1.2' }));
    steerFirst(queue, 'uuid-1');

    queue.cancelSession(SESSION, 'session deleted');

    expect(queue.list(SESSION).map((item) => item.state)).toEqual(['cancelled', 'cancelled']);
    expect(queue.list(SESSION)[0].steerUuid).toBeUndefined();
    expect(queue.markConsumed(SESSION, 'uuid-1')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('FollowupQueue editQueued (06 §3.4 Edit)', () => {
  it('rewrites the stored text of a queued item and bumps its epoch', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1', text: '배포 상태 알려줘' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    const edited = queue.editQueued(SESSION, first.item.id, first.item.epoch, '배포 상태 말고 로그 보여줘');

    expect(edited.ok && edited.item.message.text).toBe('배포 상태 말고 로그 보여줘');
    expect(edited.ok && edited.item.state).toBe('queued');
    expect(edited.ok && edited.item.stateReason).toBe('편집됨');
    // A new epoch is what makes a control rendered against the OLD text stale.
    expect(edited.ok && edited.item.epoch).toBe(first.item.epoch + 1);
    expect(queue.get(SESSION, first.item.id)?.message.text).toBe('배포 상태 말고 로그 보여줘');
  });

  it('keeps everything except the text — author, files and seq are the original event (A30)', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1', user: 'U_AUTHOR', text: '원문' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    const edited = queue.editQueued(SESSION, first.item.id, first.item.epoch, '편집본');

    expect(edited.ok && edited.item.message.user).toBe('U_AUTHOR');
    expect(edited.ok && edited.item.message.ts).toBe('1.1');
    expect(edited.ok && edited.item.seq).toBe(first.item.seq);
    expect(edited.ok && edited.item.eventKey).toBe(first.item.eventKey);
  });

  it('is still claimable afterwards — an edit is not a state change', () => {
    const queue = new FollowupQueue();
    const first = queue.enqueue(SESSION, event({ ts: '1.1' }));
    if (first.status !== 'queued') throw new Error('setup failed');

    queue.editQueued(SESSION, first.item.id, first.item.epoch, '편집본');

    const claimed = queue.claimNext(SESSION);
    expect(claimed.ok && claimed.item.message.text).toBe('편집본');
  });

  it('refuses a steered item — the SDK already holds the original copy', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1', text: '원문' }));
    const steered = steerFirst(queue, 'uuid-1');

    expect(queue.editQueued(SESSION, steered.id, steered.epoch, '편집본')).toEqual({
      ok: false,
      reason: 'invalid-state',
    });
    expect(queue.get(SESSION, steered.id)?.message.text).toBe('원문');
    expect(queue.get(SESSION, steered.id)?.steerUuid).toBe('uuid-1');
  });

  it('refuses a dispatched item and a stale epoch', () => {
    const queue = new FollowupQueue();
    queue.enqueue(SESSION, event({ ts: '1.1', text: '원문' }));
    const dispatched = dispatchFirst(queue);

    expect(queue.editQueued(SESSION, dispatched.id, dispatched.epoch, '편집본')).toEqual({
      ok: false,
      reason: 'invalid-state',
    });
    expect(queue.editQueued(SESSION, dispatched.id, dispatched.epoch - 1, '편집본')).toEqual({
      ok: false,
      reason: 'stale-epoch',
    });
    expect(queue.get(SESSION, dispatched.id)?.message.text).toBe('원문');
  });

  it('answers not-found for an unknown item', () => {
    const queue = new FollowupQueue();
    expect(queue.editQueued(SESSION, `${SESSION}#99`, 0, '편집본')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('persists the edit before memory — a throwing sink leaves the original text', () => {
    const save = vi.fn(() => {
      throw new Error('disk full');
    });
    const seed = new FollowupQueue();
    seed.enqueue(SESSION, event({ ts: '1.1', text: '원문' }));
    const queue = new FollowupQueue({ snapshot: seed.snapshot(), save });
    const target = queue.list(SESSION)[0];

    expect(() => queue.editQueued(SESSION, target.id, target.epoch, '편집본')).toThrow('disk full');
    expect(queue.get(SESSION, target.id)?.message.text).toBe('원문');
    expect(queue.get(SESSION, target.id)?.epoch).toBe(target.epoch);
  });
});
