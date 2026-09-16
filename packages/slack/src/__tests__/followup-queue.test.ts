import { describe, expect, it, vi } from 'vitest';
import { FOLLOWUP_QUEUE_DEFAULT_CAPACITY, FollowupQueue, type FollowupQueueSnapshot } from '../followup-queue';
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

  it('refuses retry while the session is frozen, so no undrainable queued item appears (A29)', () => {
    const source = new FollowupQueue();
    source.enqueue(SESSION, event({ ts: '1.1' }));
    dispatchFirst(source);
    const queue = new FollowupQueue({ snapshot: source.snapshot() });
    queue.recover('process restart');
    const uncertain = queue.list(SESSION)[0];

    expect(queue.retry(SESSION, uncertain.id, uncertain.epoch)).toEqual({ ok: false, reason: 'frozen' });
    expect(queue.list(SESSION)[0].state).toBe('uncertain');
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
