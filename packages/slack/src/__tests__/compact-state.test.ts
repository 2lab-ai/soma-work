import { describe, expect, it } from 'vitest';
import {
  COMPACTION_IN_PROGRESS_MAX_MS,
  type CompactStateSession,
  isCompactionInProgress,
  promotePendingToDispatchQueue,
  stashUserMessageDuringCompaction,
} from '../compact-state';

const NOW = 1_750_000_000_000;

function openCycleSession(overrides: Partial<CompactStateSession> = {}): CompactStateSession {
  return {
    compactEpoch: 3,
    compactPostedByEpoch: { 3: { pre: true, post: false } },
    compactStartedAtMs: NOW - 30_000,
    ...overrides,
  };
}

describe('isCompactionInProgress', () => {
  it('true while the current epoch cycle is open (pre=true, post=false) and recent', () => {
    expect(isCompactionInProgress(openCycleSession(), NOW)).toBe(true);
  });

  it('false when no cycle was ever started', () => {
    expect(isCompactionInProgress({}, NOW)).toBe(false);
  });

  it('false before the START signal claimed the cycle (pre=false)', () => {
    const s = openCycleSession({ compactPostedByEpoch: { 3: { pre: false, post: false } } });
    expect(isCompactionInProgress(s, NOW)).toBe(false);
  });

  it('false once the cycle sealed (post=true)', () => {
    const s = openCycleSession({ compactPostedByEpoch: { 3: { pre: true, post: true } } });
    expect(isCompactionInProgress(s, NOW)).toBe(false);
  });

  it('false when the open cycle is older than the safety ceiling (never a stuck guard)', () => {
    const s = openCycleSession({ compactStartedAtMs: NOW - COMPACTION_IN_PROGRESS_MAX_MS - 1 });
    expect(isCompactionInProgress(s, NOW)).toBe(false);
  });

  it('false when the start timestamp is missing (defensive)', () => {
    const s = openCycleSession({ compactStartedAtMs: null });
    expect(isCompactionInProgress(s, NOW)).toBe(false);
  });
});

describe('stashUserMessageDuringCompaction', () => {
  const u1 = { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '1.0' };
  const u2 = { channel: 'C1', threadTs: 'T1', user: 'U2', ts: '2.0' };

  it('starts the dispatch queue when nothing is stashed yet', () => {
    const s: CompactStateSession = {};
    stashUserMessageDuringCompaction(s, u1, 'hello');
    expect(s.compactPendingDispatches).toEqual([{ ctx: u1, text: 'hello' }]);
  });

  it('appends to the pre-compact pending message when the SAME user sends more text', () => {
    const firstCtx = { ...u1, ts: '0.5' };
    const s: CompactStateSession = { pendingUserText: 'first', pendingEventContext: firstCtx };
    stashUserMessageDuringCompaction(s, u1, 'second');
    expect(s.pendingUserText).toBe('first\nsecond');
    expect(s.pendingEventContext).toEqual(firstCtx);
    expect(s.compactPendingDispatches ?? []).toEqual([]);
  });

  it('codex F4: a DIFFERENT user is queued as a separate entry with their own ctx — never merged', () => {
    const s: CompactStateSession = { pendingUserText: 'u1 text', pendingEventContext: u1 };
    stashUserMessageDuringCompaction(s, u2, 'u2 text');
    expect(s.pendingUserText).toBe('u1 text'); // untouched
    expect(s.compactPendingDispatches).toEqual([{ ctx: u2, text: 'u2 text' }]);
  });

  it('merges contiguous same-user bursts in the queue, keeps cross-user entries separate', () => {
    const s: CompactStateSession = {};
    stashUserMessageDuringCompaction(s, u1, 'a');
    stashUserMessageDuringCompaction(s, u1, 'b');
    stashUserMessageDuringCompaction(s, u2, 'c');
    stashUserMessageDuringCompaction(s, u2, 'd');
    expect(s.compactPendingDispatches).toEqual([
      { ctx: u1, text: 'a\nb' },
      { ctx: u2, text: 'c\nd' },
    ]);
  });

  it('ignores empty text', () => {
    const s: CompactStateSession = {};
    stashUserMessageDuringCompaction(s, u1, '');
    expect(s.compactPendingDispatches ?? []).toEqual([]);
  });
});

describe('promotePendingToDispatchQueue', () => {
  const u1 = { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '1.0' };
  const u2 = { channel: 'C1', threadTs: 'T1', user: 'U2', ts: '2.0' };

  it('moves pendingUserText to the FRONT of the queue (earliest message first)', () => {
    const s: CompactStateSession = {
      pendingUserText: 'intercepted',
      pendingEventContext: u1,
      compactPendingDispatches: [{ ctx: u2, text: 'arrived during compaction' }],
    };
    promotePendingToDispatchQueue(s);
    expect(s.compactPendingDispatches).toEqual([
      { ctx: u1, text: 'intercepted' },
      { ctx: u2, text: 'arrived during compaction' },
    ]);
    expect(s.pendingUserText).toBeNull();
    expect(s.pendingEventContext).toBeNull();
  });

  it('is idempotent — second call (double END signal) is a no-op', () => {
    const s: CompactStateSession = { pendingUserText: 'x', pendingEventContext: u1 };
    promotePendingToDispatchQueue(s);
    promotePendingToDispatchQueue(s);
    expect(s.compactPendingDispatches).toEqual([{ ctx: u1, text: 'x' }]);
  });

  it('no-op when nothing is pending', () => {
    const s: CompactStateSession = {};
    promotePendingToDispatchQueue(s);
    expect(s.compactPendingDispatches ?? null).toBeNull();
  });
});
