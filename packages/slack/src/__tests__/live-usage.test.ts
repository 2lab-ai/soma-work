/**
 * SSOT 2026-10-22 T1/T2 — the running turn's usage, call by call, so the
 * dashboard's token and cost totals grow during a turn instead of jumping at
 * its end.
 */
import { describe, expect, it } from 'vitest';
import {
  clearLiveUsage,
  foldLiveUsage,
  liveOccupancyCall,
  markLiveUsageBoundary,
  markLiveUsageSettled,
  recordLiveUsage,
  sumLiveUsage,
} from '../live-usage';

const call = (messageId: string | undefined, n: number) => ({
  messageId,
  inputTokens: n,
  outputTokens: n * 2,
  cacheReadTokens: n * 3,
  cacheCreateTokens: n * 4,
});

describe('live usage of the running turn', () => {
  it('adds up one entry per API call', () => {
    const session: Record<string, any> = {};
    recordLiveUsage(session, call('msg_1', 1));
    recordLiveUsage(session, call('msg_2', 10));
    expect(sumLiveUsage(session.liveUsage)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreateTokens: 44,
    });
  });

  it("a subagent's call (sidechain) counts in the totals but never as the main context's occupancy — spec 12 §2.5", () => {
    const session: Record<string, any> = {};
    recordLiveUsage(session, call('msg_main', 1));
    recordLiveUsage(session, { ...call('msg_sub', 1000), sidechain: true });
    expect(sumLiveUsage(session.liveUsage).inputTokens).toBe(1001);
    expect(liveOccupancyCall(session)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreateTokens: 4,
    });
    // Only sidechain calls so far: no occupancy reading at all.
    const sub: Record<string, any> = {};
    recordLiveUsage(sub, { ...call('msg_sub', 5), sidechain: true });
    expect(liveOccupancyCall(sub)).toBeUndefined();
    expect(sumLiveUsage(sub.liveUsage).inputTokens).toBe(5);
  });

  it('a call reported on several frames (same message id) counts once — the latest report wins', () => {
    const session: Record<string, any> = {};
    recordLiveUsage(session, call('msg_1', 1));
    recordLiveUsage(session, call('msg_1', 5));
    expect(sumLiveUsage(session.liveUsage).inputTokens).toBe(5);
  });

  it('a report without a message id is its own call', () => {
    const session: Record<string, any> = {};
    recordLiveUsage(session, call(undefined, 1));
    recordLiveUsage(session, call(undefined, 1));
    expect(sumLiveUsage(session.liveUsage).inputTokens).toBe(2);
  });

  it('ignores non-numbers and negatives; an empty or missing map sums to zero', () => {
    const session: Record<string, any> = {};
    recordLiveUsage(session, {
      messageId: 'm',
      inputTokens: -5,
      outputTokens: Number.NaN,
      cacheReadTokens: 'x' as any,
      cacheCreateTokens: 3,
    });
    expect(sumLiveUsage(session.liveUsage)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 3,
    });
    expect(sumLiveUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
  });

  it('clearing drops the running turn once its result usage is in the totals', () => {
    const session: Record<string, any> = {};
    recordLiveUsage(session, call('a', 1));
    clearLiveUsage(session);
    expect(session.liveUsage).toBeUndefined();
  });

  it('belongs to one turn: a call of the next turn starts afresh; an old turn’s cleanup leaves the new one alone', () => {
    const session: Record<string, any> = {};
    recordLiveUsage(session, call('a', 1), 'turn-1');
    recordLiveUsage(session, call('b', 7), 'turn-2');
    expect(sumLiveUsage(session.liveUsage).inputTokens).toBe(7);
    clearLiveUsage(session, 'turn-1');
    expect(sumLiveUsage(session.liveUsage).inputTokens).toBe(7);
    clearLiveUsage(session, 'turn-2');
    expect(session.liveUsage).toBeUndefined();
  });

  it('a turn that ends without its result folds its reported calls into the totals (review F4)', () => {
    const session: Record<string, any> = {
      usage: {
        totalInputTokens: 10,
        totalOutputTokens: 1,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 1,
      },
    };
    recordLiveUsage(session, call('a', 100), 't1');
    expect(foldLiveUsage(session, 't1', () => 0.5)).toBe(true);
    expect(session.usage).toMatchObject({ totalInputTokens: 110, totalOutputTokens: 201, totalCostUsd: 1.5 });
    expect(session.liveUsage).toBeUndefined();
    // Another turn's calls are not this turn's to fold.
    recordLiveUsage(session, call('b', 5), 't2');
    expect(foldLiveUsage(session, 't1', () => 1)).toBe(false);
    expect(sumLiveUsage(session.liveUsage).inputTokens).toBe(5);
  });

  it('folding keeps the context the interrupted turn reached as the current occupancy (review R2-1)', () => {
    const session: Record<string, any> = {
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 0,
        currentInputTokens: 300_000,
        currentOutputTokens: 0,
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
      },
    };
    recordLiveUsage(
      session,
      { messageId: 'a', inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 589_000, cacheCreateTokens: 0 },
      't',
    );
    foldLiveUsage(session, 't', () => 0);
    expect(session.usage).toMatchObject({
      currentInputTokens: 10_000,
      currentCacheReadTokens: 589_000,
      currentOutputTokens: 1_000,
    });
  });

  it('the turn that compacted keeps the post-compact occupancy; its spend still folds (review R3-1)', () => {
    // An interrupted /compact turn: the boundary set the occupancy to post_tokens
    // and shielded it for this turn; its summarization call read the whole
    // pre-compact transcript and must not put that number back.
    const session: Record<string, any> = {
      postCompactOccupancyTurnId: 't',
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 0,
        currentInputTokens: 30_000,
        currentOutputTokens: 0,
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
      },
    };
    recordLiveUsage(
      session,
      { messageId: 'a', inputTokens: 4_000, outputTokens: 800, cacheReadTokens: 670_000, cacheCreateTokens: 0 },
      't',
    );
    expect(foldLiveUsage(session, 't', () => 2)).toBe(true);
    expect(session.usage).toMatchObject({
      currentInputTokens: 30_000,
      currentOutputTokens: 0,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      totalInputTokens: 4_000,
      totalOutputTokens: 800,
      totalCacheReadTokens: 670_000,
      totalCostUsd: 2,
    });
  });

  it('after the boundary, the turn’s later calls are the real occupancy — only the pre-boundary ones are held back (review R4)', () => {
    // A turn that compacted mid-way and went on working, then was stopped: its
    // calls after the boundary read the compacted context and are genuine.
    const session: Record<string, any> = {
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 0,
        currentInputTokens: 700_000,
        currentOutputTokens: 0,
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
      },
    };
    recordLiveUsage(session, call('pre', 700_000), 't');
    // The boundary: occupancy = post_tokens, shielded for this turn.
    session.usage.currentInputTokens = 30_000;
    session.postCompactOccupancyTurnId = 't';
    markLiveUsageBoundary(session, 't');
    recordLiveUsage(session, call('pre', 700_000), 't'); // a late re-report of the pre-boundary call
    recordLiveUsage(session, call('post', 600_000), 't');
    expect(liveOccupancyCall(session)?.inputTokens).toBe(600_000);
    foldLiveUsage(session, 't', () => 0);
    expect(session.usage.currentInputTokens).toBe(600_000);
    expect(session.usage.totalInputTokens).toBe(1_300_000);
  });

  it('a boundary before the turn’s first call still marks it: every later call is post-boundary (review R5-1)', () => {
    // SDK auto-compact on a resumed turn, before its first assistant message.
    const session: Record<string, any> = { postCompactOccupancyTurnId: 't' };
    markLiveUsageBoundary(session, 't');
    recordLiveUsage(session, call('post', 600_000), 't');
    expect(liveOccupancyCall(session)?.inputTokens).toBe(600_000);
  });

  it('overlapping turns: the turn holding the shield holds the mark, whoever claimed the map first (review R6)', () => {
    const session: Record<string, any> = {};
    // A compacts before its first call and is superseded by B, which does the same.
    session.postCompactOccupancyTurnId = 'A';
    markLiveUsageBoundary(session, 'A');
    session.postCompactOccupancyTurnId = 'B';
    markLiveUsageBoundary(session, 'B');
    recordLiveUsage(session, call('post', 600_000), 'B');
    expect(liveOccupancyCall(session)?.inputTokens).toBe(600_000);
  });

  it('the superseded turn’s late boundary marks only itself: B’s calls are untouched and A’s fold is a no-op', () => {
    const session: Record<string, any> = { postCompactOccupancyTurnId: 'B' };
    markLiveUsageBoundary(session, 'B');
    recordLiveUsage(session, call('post', 600_000), 'B');
    markLiveUsageBoundary(session, 'A'); // A's stack, late: B owns the map — A has no calls in it
    expect(foldLiveUsage(session, 'A', () => 0)).toBe(false);
    clearLiveUsage(session, 'A');
    expect(sumLiveUsage(session.liveUsage).inputTokens).toBe(600_000);
  });

  it('a shield with no boundary mark holds every call back (never restores pre-compact occupancy)', () => {
    const session: Record<string, any> = { postCompactOccupancyTurnId: 't' };
    recordLiveUsage(session, call('a', 700_000), 't');
    expect(liveOccupancyCall(session)).toBeUndefined();
  });

  it('the boundary mark belongs to its turn and goes with that turn’s clear', () => {
    const session: Record<string, any> = { postCompactOccupancyTurnId: 't' };
    recordLiveUsage(session, call('a', 5), 't');
    markLiveUsageBoundary(session, 't');
    expect(liveOccupancyCall(session)).toBeUndefined(); // only a pre-boundary call so far
    recordLiveUsage(session, call('b', 7), 't');
    expect(liveOccupancyCall(session)?.inputTokens).toBe(7);
    clearLiveUsage(session, 't');
    expect(session.liveUsageBoundary).toBeUndefined();
  });

  it('a shield another turn set does not hold this turn’s occupancy (review R3-1)', () => {
    const session: Record<string, any> = {
      postCompactOccupancyTurnId: 'older',
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 0,
        currentInputTokens: 30_000,
        currentOutputTokens: 0,
        currentCacheReadTokens: 0,
        currentCacheCreateTokens: 0,
      },
    };
    recordLiveUsage(session, call('a', 90_000), 't');
    foldLiveUsage(session, 't', () => 0);
    expect(session.usage.currentInputTokens).toBe(90_000);
  });

  it('a turn whose result usage was applied is never folded again (review: double count)', () => {
    const session: Record<string, any> = {
      usage: {
        totalInputTokens: 5,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 0,
      },
    };
    recordLiveUsage(session, call('a', 100), 't');
    markLiveUsageSettled(session, 't');
    expect(foldLiveUsage(session, 't', () => 1)).toBe(false);
    expect(session.usage.totalInputTokens).toBe(5);
  });
});
