import { describe, expect, it } from 'vitest';
import {
  AUTO_COMPACT_FAILURE_COOLDOWN_MAX_MS,
  AUTO_COMPACT_FAILURE_COOLDOWN_MS,
  COMPACTION_IN_PROGRESS_MAX_MS,
  type CompactStateSession,
  isAutoCompactPaused,
  isCompactionInProgress,
  pauseAutoCompactAfterFailure,
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

  // PR #305: a goal objective (`verbatimPrompt`) replays as the user's words,
  // never as a command. Merging it with ordinary text would change the
  // meaning of one or the other, so it always gets its own entry.
  it('never merges a verbatim goal objective with ordinary same-user text', () => {
    const v1 = { ...u1, verbatimPrompt: true };
    const s: CompactStateSession = { pendingUserText: 'first', pendingEventContext: u1 };
    stashUserMessageDuringCompaction(s, v1, 'new dashboard 구현');
    stashUserMessageDuringCompaction(s, u1, 'and then this');
    expect(s.pendingUserText).toBe('first');
    expect(s.compactPendingDispatches).toEqual([
      { ctx: v1, text: 'new dashboard 구현' },
      { ctx: u1, text: 'and then this' },
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

describe('pauseAutoCompactAfterFailure / isAutoCompactPaused (compact retry loop breaker)', () => {
  it('pauses for the default cooldown when no retry-after is known, and clears a pending flag', () => {
    const s: CompactStateSession = { autoCompactPending: true };
    const until = pauseAutoCompactAfterFailure(s, null, NOW);
    expect(until).toBe(NOW + AUTO_COMPACT_FAILURE_COOLDOWN_MS);
    expect(s.autoCompactSuppressedUntilMs).toBe(until);
    expect(s.autoCompactPending).toBe(false);
  });

  it('honours a longer advertised retry-after window (pool 429 "retry in 3653s")', () => {
    const s: CompactStateSession = {};
    expect(pauseAutoCompactAfterFailure(s, 3_653_000, NOW)).toBe(NOW + 3_653_000);
  });

  it('never pauses for less than the default cooldown', () => {
    const s: CompactStateSession = {};
    expect(pauseAutoCompactAfterFailure(s, 5_000, NOW)).toBe(NOW + AUTO_COMPACT_FAILURE_COOLDOWN_MS);
  });

  it('caps an absurd retry-after hint', () => {
    const s: CompactStateSession = {};
    expect(pauseAutoCompactAfterFailure(s, 1e12, NOW)).toBe(NOW + AUTO_COMPACT_FAILURE_COOLDOWN_MAX_MS);
  });

  it('never shortens a pause that is already longer', () => {
    const s: CompactStateSession = {};
    pauseAutoCompactAfterFailure(s, 3_653_000, NOW);
    expect(pauseAutoCompactAfterFailure(s, null, NOW + 1_000)).toBe(NOW + 3_653_000);
  });

  it('is paused strictly before the end and not at or after it', () => {
    const s: CompactStateSession = {};
    const until = pauseAutoCompactAfterFailure(s, null, NOW);
    expect(isAutoCompactPaused(s, until - 1)).toBe(true);
    expect(isAutoCompactPaused(s, until)).toBe(false);
  });

  it('is not paused when no failure was recorded', () => {
    expect(isAutoCompactPaused({}, NOW)).toBe(false);
    expect(isAutoCompactPaused({ autoCompactSuppressedUntilMs: null }, NOW)).toBe(false);
  });
});

// A host turn soma-work injected (a goal continuation, a resume) that the
// auto-compact intercepted or a compaction parked keeps saying so through the
// replay: its entry is never merged with a person's words, either way.
describe('host turns stay host turns through the replay queue', () => {
  const host = { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '1.0', hostTurn: true };
  const person = { channel: 'C1', threadTs: 'T1', user: 'U1', ts: '2.0' };

  it('a host turn gets its own entry; a person who writes next gets theirs', () => {
    const s: CompactStateSession = {};
    stashUserMessageDuringCompaction(s, host, '[goal-continuation] Continue');
    stashUserMessageDuringCompaction(s, person, '이것도 해줘');
    expect(s.compactPendingDispatches).toEqual([
      { ctx: host, text: '[goal-continuation] Continue' },
      { ctx: person, text: '이것도 해줘' },
    ]);
  });

  it('a person’s words never merge into an intercepted host turn (pendingUserText)', () => {
    const s: CompactStateSession = { pendingUserText: '[goal-continuation] Continue', pendingEventContext: host };
    stashUserMessageDuringCompaction(s, person, '이것도 해줘');
    expect(s.pendingUserText).toBe('[goal-continuation] Continue');
    expect(s.compactPendingDispatches).toEqual([{ ctx: person, text: '이것도 해줘' }]);
  });

  it('promote carries the marker to the front of the queue', () => {
    const s: CompactStateSession = { pendingUserText: '[goal-continuation] Continue', pendingEventContext: host };
    promotePendingToDispatchQueue(s);
    expect(s.compactPendingDispatches).toEqual([{ ctx: host, text: '[goal-continuation] Continue' }]);
  });
});
