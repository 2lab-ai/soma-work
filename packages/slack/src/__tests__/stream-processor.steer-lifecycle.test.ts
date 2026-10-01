/**
 * `steer_lifecycle` is a SIDE-BAND signal: it tells the host which queued user
 * message the running turn consumed (`uuid` + phase), and nothing else. It
 * produces no Slack output, so the processor must hand it to the callback
 * WITHOUT touching the render groups — an interleaved steer frame that flushed
 * would fragment the streaming text into extra appends, which is visible to the
 * user and is exactly the bug these tests exist to keep out.
 *
 * Same shape as the `agent_task_lifecycle` case it copies (stream-processor.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import {
  AgentStreamProcessor,
  classifyProgressSignal,
  type StreamCallbacks,
  type StreamContext,
} from '../stream-processor';

function streamingContext(appendText = vi.fn().mockResolvedValue(true)) {
  const say = vi.fn().mockResolvedValue({ ts: 'm' });
  const context: StreamContext = {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    turnId: 'C1:T1:turn-1',
    threadPanel: {
      isTurnSurfaceActive: () => true,
      appendText,
    },
    say: say as unknown as StreamContext['say'],
  };
  return { context, appendText, say };
}

async function runStream(events: AgentStreamEvent[], callbacks: StreamCallbacks = {}) {
  const { context, appendText, say } = streamingContext();
  const processor = new AgentStreamProcessor(callbacks);
  const result = await processor.process(
    (async function* () {
      for (const event of events) yield event;
    })(),
    context,
    new AbortController().signal,
  );
  return { result, appendText, say };
}

const STEER_COMPLETED: AgentStreamEvent = { type: 'steer_lifecycle', uuid: 'u-steer-1', phase: 'completed' };

describe('StreamProcessor — steer_lifecycle side-band callback', () => {
  it('invokes onSteerLifecycle exactly once with the event and the stream context', async () => {
    const onSteerLifecycle = vi.fn();

    const { result } = await runStream(
      [{ type: 'assistant_delta', text: '작업 중' }, STEER_COMPLETED, { type: 'result', stopReason: 'end_turn' }],
      { onSteerLifecycle },
    );

    expect(result.success).toBe(true);
    expect(onSteerLifecycle).toHaveBeenCalledTimes(1);
    expect(onSteerLifecycle.mock.calls[0][0]).toEqual(STEER_COMPLETED);
    expect(onSteerLifecycle.mock.calls[0][1]).toMatchObject({ sessionKey: 'C1:T1', channel: 'C1', threadTs: 'T1' });
  });

  it('does NOT flush the render groups — output and flush count match the same stream without it', async () => {
    const withEvent = await runStream(
      [
        { type: 'assistant_delta', text: '첫 문장 ' },
        STEER_COMPLETED,
        { type: 'assistant_delta', text: '두 번째 문장' },
        { type: 'result', stopReason: 'end_turn' },
      ],
      { onSteerLifecycle: vi.fn() },
    );

    const withoutEvent = await runStream([
      { type: 'assistant_delta', text: '첫 문장 ' },
      { type: 'assistant_delta', text: '두 번째 문장' },
      { type: 'result', stopReason: 'end_turn' },
    ]);

    const appends = (calls: unknown[][]) => calls.map((c) => c[1]);
    expect(withEvent.appendText).toHaveBeenCalledTimes(withoutEvent.appendText.mock.calls.length);
    expect(appends(withEvent.appendText.mock.calls)).toEqual(appends(withoutEvent.appendText.mock.calls));
    expect(withEvent.say.mock.calls.length).toBe(withoutEvent.say.mock.calls.length);
  });

  it('awaits an async callback before pulling the next event', async () => {
    const order: string[] = [];
    const onSteerLifecycle = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('callback');
    });
    const { context } = streamingContext();
    const processor = new AgentStreamProcessor({ onSteerLifecycle });

    await processor.process(
      (async function* () {
        yield STEER_COMPLETED;
        // Runs only when the loop asks for the next event.
        order.push('next-pulled');
        yield { type: 'result', stopReason: 'end_turn' } as AgentStreamEvent;
      })(),
      context,
      new AbortController().signal,
    );

    expect(order).toEqual(['callback', 'next-pulled']);
  });

  // The registry update behind this hook is bookkeeping; a bug in it must not
  // destroy the turn the user is watching.
  it('a throwing callback cannot break the stream loop', async () => {
    const onSteerLifecycle = vi.fn(() => {
      throw new Error('registry bug');
    });

    const { result, appendText } = await runStream(
      [STEER_COMPLETED, { type: 'assistant_delta', text: '계속 진행' }, { type: 'result', stopReason: 'end_turn' }],
      { onSteerLifecycle },
    );

    expect(onSteerLifecycle).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(appendText.mock.calls.map((c: unknown[]) => c[1]).join('')).toContain('계속 진행');
  });

  it('a rejecting async callback cannot break the stream loop', async () => {
    const onSteerLifecycle = vi.fn().mockRejectedValue(new Error('registry bug'));

    const { result } = await runStream([STEER_COMPLETED, { type: 'result', stopReason: 'end_turn' }], {
      onSteerLifecycle,
    });

    expect(result.success).toBe(true);
  });

  it('runs without a callback wired (hosts that do not track steering)', async () => {
    const { result } = await runStream([STEER_COMPLETED, { type: 'result', stopReason: 'end_turn' }]);
    expect(result.success).toBe(true);
  });

  // Steering bookkeeping is not work the user can see: a queue drain must not
  // be able to keep the header's "마지막 활동" clock alive on its own.
  it('is NOT a progress signal', () => {
    expect(classifyProgressSignal(STEER_COMPLETED)).toBeUndefined();
  });
});
