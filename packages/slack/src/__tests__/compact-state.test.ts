import { describe, expect, it } from 'vitest';
import {
  COMPACTION_IN_PROGRESS_MAX_MS,
  type CompactStateSession,
  isCompactionInProgress,
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
  const ctx = { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '1.0' };

  it('becomes the pending message when nothing is stashed yet', () => {
    const s: CompactStateSession = {};
    stashUserMessageDuringCompaction(s, ctx, 'hello');
    expect(s.pendingUserText).toBe('hello');
    expect(s.pendingEventContext).toEqual(ctx);
  });

  it('appends to an existing pre-compact pending message, keeping the original context', () => {
    const firstCtx = { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '0.5' };
    const s: CompactStateSession = { pendingUserText: 'first', pendingEventContext: firstCtx };
    stashUserMessageDuringCompaction(s, ctx, 'second');
    expect(s.pendingUserText).toBe('first\nsecond');
    expect(s.pendingEventContext).toEqual(firstCtx);
  });

  it('appends to a parked deferred dispatch when the cycle already sealed', () => {
    const s: CompactStateSession = {
      compactPendingDispatch: { ctx, text: 'parked' },
    };
    stashUserMessageDuringCompaction(s, { ...ctx, ts: '2.0' }, 'late-arrival');
    expect(s.compactPendingDispatch?.text).toBe('parked\nlate-arrival');
    expect(s.pendingUserText).toBeUndefined();
  });

  it('ignores empty text', () => {
    const s: CompactStateSession = {};
    stashUserMessageDuringCompaction(s, ctx, '');
    expect(s.pendingUserText).toBeUndefined();
    expect(s.pendingEventContext).toBeUndefined();
  });
});
