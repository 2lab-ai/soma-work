/**
 * SSOT 2026-10-22 T1/T2 — every API call's usage reaches the host while the
 * turn runs (`onLiveUsage`), with the message id it belongs to, so the
 * dashboard's totals grow live.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import { LOG_MINIMAL } from '../output-flags';
import { AgentStreamProcessor, type StreamContext } from '../stream-processor';

async function* events(list: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
}

function context(): StreamContext {
  return {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    incidentAttempt: false,
    logVerbosity: LOG_MINIMAL,
    say: vi.fn().mockResolvedValue({ ts: 'm' }) as unknown as StreamContext['say'],
  };
}

describe('live per-call usage (onLiveUsage)', () => {
  it('reports each per-call usage with its message id, before the turn ends', async () => {
    const seen: unknown[] = [];
    const onLiveUsage = vi.fn((c: unknown) => seen.push(c));
    const onUsageUpdate = vi.fn(() => {
      // The result usage arrives after every live report of the turn.
      expect(seen).toHaveLength(2);
    });
    await new AgentStreamProcessor({ onLiveUsage, onUsageUpdate }).process(
      events([
        {
          type: 'usage',
          usage: {
            lastTurnInputTokens: 10,
            lastTurnOutputTokens: 2,
            lastTurnCacheReadTokens: 300,
            lastTurnCacheCreateTokens: 4,
            lastTurnMessageId: 'msg_1',
          },
        },
        { type: 'assistant_delta', text: 'working' },
        { type: 'usage', usage: { lastTurnInputTokens: 5, lastTurnMessageId: 'msg_2' } },
        { type: 'usage', usage: { inputTokens: 15, outputTokens: 2, totalCostUsd: 0.01 } },
        { type: 'result', stopReason: 'end_turn', finalText: 'done' },
      ]),
      context(),
      new AbortController().signal,
    );
    expect(seen).toEqual([
      { messageId: 'msg_1', inputTokens: 10, outputTokens: 2, cacheReadTokens: 300, cacheCreateTokens: 4 },
      { messageId: 'msg_2', inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    ]);
    expect(onUsageUpdate).toHaveBeenCalledTimes(1);
  });

  it('a throwing host callback never breaks the turn', async () => {
    const onLiveUsage = vi.fn(() => {
      throw new Error('boom');
    });
    const r = await new AgentStreamProcessor({ onLiveUsage }).process(
      events([
        { type: 'usage', usage: { lastTurnInputTokens: 1, lastTurnMessageId: 'm' } },
        { type: 'result', stopReason: 'end_turn', finalText: 'ok' },
      ]),
      context(),
      new AbortController().signal,
    );
    expect(onLiveUsage).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
  });
});
