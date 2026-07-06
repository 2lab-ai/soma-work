/**
 * Auto fallback compact (prompt-too-long emergency recovery) — adapter side.
 *
 * When StreamExecutor.execute() returns `{ success: false, fallbackCompact:
 * true }`, its handleError has already:
 *   - switched `session.model` to the configured 1M compact model
 *     (default `opus[1m]` → `claude-opus-4-8[1m]`), and
 *   - stashed the original model + the triggering user text on the session.
 *
 * The adapter must immediately re-enter with the SDK-local `/compact`
 * command (which now fits in the 1M window) instead of throwing or letting
 * SlackHandler's generic auto-retry replay the failed prompt.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnResultCollector } from '../turn-result-collector.js';
import { V1QueryAdapter } from '../v1-query-adapter.js';

function createMockExecuteParams() {
  return {
    session: { model: 'claude-opus-4-8[1m]', fallbackCompactActive: true } as any,
    sessionKey: 'C1-171.100',
    userName: 'testuser',
    workingDirectory: '/tmp/test',
    abortController: new AbortController(),
    processedFiles: [],
    channel: 'C1',
    threadTs: '171.100',
    user: 'U1',
    say: vi.fn(),
  };
}

describe('V1QueryAdapter — auto fallback compact retry', () => {
  let executeParams: ReturnType<typeof createMockExecuteParams>;

  beforeEach(() => {
    executeParams = createMockExecuteParams();
  });

  it('re-enters with /compact when execute() reports fallbackCompact', async () => {
    const compactCollector = new TurnResultCollector();
    compactCollector.onText('Compaction done');
    compactCollector.onEndTurn({ reason: 'end_turn', timestamp: Date.now() });

    const execute = vi
      .fn()
      // First turn: prompt-too-long → handleError armed the fallback.
      .mockResolvedValueOnce({
        success: false,
        messageCount: 0,
        retryAfterMs: 500,
        fallbackCompact: true,
        handled: false,
      })
      // Second turn: the /compact retry succeeds on the 1M model.
      .mockResolvedValueOnce({
        success: true,
        messageCount: 1,
        turnCollector: compactCollector,
      });

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams,
    });

    const result = await adapter.start('아주 긴 유저 메시지');

    expect(execute).toHaveBeenCalledTimes(2);
    // Retry must be the raw SDK-local /compact command so stream-executor's
    // slash-command bypass hands it to the SDK verbatim.
    expect(execute.mock.calls[1][0].text).toBe('/compact');
    // The retry is a synthetic turn, never user input.
    expect(execute.mock.calls[1][0].isUserInput).toBe(false);
    // Adapter resolves with the compact turn's result — no throw.
    expect(result.messages).toEqual(['Compaction done']);
    // SlackHandler's generic auto-retry must NOT double-fire.
    expect(adapter.getRetryAfterMs()).toBeUndefined();
  });

  it('does not trigger /compact retry for ordinary failures', async () => {
    const execute = vi.fn().mockResolvedValue({
      success: false,
      messageCount: 0,
      retryAfterMs: 30_000,
      handled: false,
    });

    const adapter = new V1QueryAdapter({
      streamExecutor: { execute } as any,
      executeParams,
    });

    await expect(adapter.start('hello')).rejects.toThrow('StreamExecutor returned success=false');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(adapter.getRetryAfterMs()).toBe(30_000);
  });
});
