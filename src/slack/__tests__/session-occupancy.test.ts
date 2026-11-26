/**
 * .prd/39 S1 — turn occupancy: the run phase of the session's dispatcher run, and the answers built on it.
 */
import { describe, expect, it } from 'vitest';
import { SessionOccupancy } from '../session-occupancy';

function world() {
  const slots = new Map<string, number>(); // key → live turn epoch
  const migrated = new Map<string, string>();
  const requests = new Set<string>();
  const acting = new Set<string>();
  const occupancy = new SessionOccupancy({
    slotBusy: (key) => slots.has(key),
    slotEpoch: (key) => slots.get(key),
    migratedSlotOf: (key) => migrated.get(key),
    requestActive: (key) => requests.has(key),
    loopActing: (key) => acting.has(key),
  });
  return { slots, migrated, requests, acting, occupancy };
}

describe('SessionOccupancy — run phase', () => {
  it('none with no slot and no request', () => {
    const { occupancy } = world();
    expect(occupancy.runPhase('k')).toBe('none');
    expect(occupancy.turnHeld('k')).toBe(false);
    expect(occupancy.slotHeld('k')).toBe(false);
  });

  it('preparing once a dispatch holds the slot and its turn has not reported', () => {
    const { slots, occupancy } = world();
    slots.set('k', 3);
    expect(occupancy.runPhase('k')).toBe('preparing');
    expect(occupancy.turnHeld('k')).toBe(true);
  });

  it('running with a request controller, or once the turn runtime said working', () => {
    const w = world();
    w.slots.set('k', 3);
    w.requests.add('k');
    expect(w.occupancy.runPhase('k')).toBe('running');
    w.requests.delete('k');
    w.occupancy.noteTurnActivity('k', 'working');
    expect(w.occupancy.runPhase('k')).toBe('running');
    expect(w.occupancy.turnHeld('k')).toBe(true);
  });

  it('settling once the run’s turn ended idle or waiting and the run still holds the slot', () => {
    const w = world();
    w.slots.set('k', 3);
    w.occupancy.noteTurnActivity('k', 'working');
    w.occupancy.noteTurnActivity('k', 'idle');
    expect(w.occupancy.runPhase('k')).toBe('settling');
    expect(w.occupancy.turnHeld('k')).toBe(false);
    w.occupancy.noteTurnActivity('k', 'waiting');
    expect(w.occupancy.runPhase('k')).toBe('settling');
  });

  it('settling → running when the same run starts another leg', () => {
    const w = world();
    w.slots.set('k', 3);
    w.occupancy.noteTurnActivity('k', 'idle');
    expect(w.occupancy.runPhase('k')).toBe('settling');
    w.occupancy.noteTurnActivity('k', 'working');
    expect(w.occupancy.runPhase('k')).toBe('running');
  });

  it('a mark from an earlier run does not speak for the next run: it is preparing', () => {
    const w = world();
    w.slots.set('k', 3);
    w.occupancy.noteTurnActivity('k', 'idle');
    w.slots.set('k', 4); // the next run took the slot
    expect(w.occupancy.runPhase('k')).toBe('preparing');
  });

  it('reads the source key’s slot after a bot-thread migration', () => {
    const w = world();
    w.migrated.set('canon', 'source');
    w.slots.set('source', 7);
    expect(w.occupancy.slotHeld('canon')).toBe(true);
    expect(w.occupancy.runPhase('canon')).toBe('preparing');
    w.occupancy.noteTurnActivity('canon', 'idle');
    expect(w.occupancy.runPhase('canon')).toBe('settling');
  });

  it('outside a dispatcher run, a working mark from this process still holds the turn (between legs)', () => {
    const w = world();
    w.occupancy.noteTurnActivity('k', 'working');
    expect(w.occupancy.runPhase('k')).toBe('none');
    expect(w.occupancy.turnHeld('k')).toBe(true);
    w.occupancy.noteTurnActivity('k', 'idle');
    expect(w.occupancy.turnHeld('k')).toBe(false);
  });

  it('no mark after forget — a deleted session holds nothing', () => {
    const w = world();
    w.occupancy.noteTurnActivity('k', 'working');
    w.occupancy.forget('k');
    expect(w.occupancy.turnHeld('k')).toBe(false);
  });
});

describe('SessionOccupancy — driven', () => {
  it('a run in any phase drives the session, and so does the goal loop acting', () => {
    const w = world();
    expect(w.occupancy.driven('k')).toBe(false);
    w.acting.add('k');
    expect(w.occupancy.driven('k')).toBe(true);
    w.acting.delete('k');
    w.slots.set('k', 1);
    w.occupancy.noteTurnActivity('k', 'idle'); // settling still drives: its turn end fired or will fire the loop
    expect(w.occupancy.driven('k')).toBe(true);
  });
});

describe('SessionOccupancy.ownerQuestionOpen', () => {
  it('reads the action panel', () => {
    expect(SessionOccupancy.ownerQuestionOpen(undefined)).toBe(false);
    expect(SessionOccupancy.ownerQuestionOpen({ actionPanel: {} })).toBe(false);
    expect(SessionOccupancy.ownerQuestionOpen({ actionPanel: { waitingForChoice: true } })).toBe(true);
    expect(SessionOccupancy.ownerQuestionOpen({ actionPanel: { pendingQuestion: { type: 'user_choice' } } })).toBe(
      true,
    );
  });
});
