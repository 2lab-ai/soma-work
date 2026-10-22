/**
 * SSOT 2026-10-22 T1/T2 — the running turn's usage, call by call, so the
 * dashboard's token and cost totals grow during a turn instead of jumping at
 * its end.
 */
import { describe, expect, it } from 'vitest';
import { clearLiveUsage, recordLiveUsage, sumLiveUsage } from '../live-usage';

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
});
