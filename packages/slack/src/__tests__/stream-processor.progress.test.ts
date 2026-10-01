/**
 * U9 + A11 — what the stream processor tells the header, and what it rescues
 * when an explicit interrupt ends the turn.
 *
 * U9: `onSdkActivity` is a HEARTBEAT ("the transport spoke"); `onProgress` is
 * the narrower claim ("work moved"). The header's "마지막 활동" line is only
 * honest if the second one is not fed by bookkeeping frames — usage/status/
 * compact/result frames keep arriving on a session that is producing nothing.
 *
 * A11: on an explicit `Send now` interrupt (`RequestAbortReason
 * 'user-interrupted'`) the assistant text still sitting in the render-group
 * buffer is flushed to THIS turn's stream before the processor returns.
 * Buffered tool calls are NOT flushed — rendering a tool call would claim it
 * ran, and the interrupt is what stopped it.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import {
  AgentStreamProcessor,
  classifyProgressSignal,
  type InterruptFlushOutcome,
  type StreamCallbacks,
  type StreamContext,
} from '../stream-processor';

function baseContext(overrides: Partial<StreamContext> = {}): StreamContext {
  return {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    say: vi.fn().mockResolvedValue({ ts: 'm' }) as unknown as StreamContext['say'],
    ...overrides,
  };
}

/** Context wired to an open B1 turn stream, like PHASE>=1 production. */
function streamingContext(appendText = vi.fn().mockResolvedValue(true)) {
  const say = vi.fn().mockResolvedValue({ ts: 'm' });
  const context = baseContext({
    turnId: 'C1:T1:turn-1',
    threadPanel: {
      isTurnSurfaceActive: () => true,
      appendText,
    },
    say: say as unknown as StreamContext['say'],
  });
  return { context, appendText, say };
}

/**
 * White-box handles on the processor: the rescue is private, but its logging
 * LEVEL and its returned {@link InterruptFlushOutcome} are the contract the A11
 * tests assert — "the partial answer was lost" has to be observable from
 * outside, both to the operator (warn) and to the caller (`failure`).
 */
interface RescueInternals {
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
  flushTextOnExplicitInterrupt(
    textBuf: string[],
    context: StreamContext,
    abortSignal: AbortSignal,
  ): Promise<InterruptFlushOutcome>;
}

function internals(processor: AgentStreamProcessor): RescueInternals {
  return processor as unknown as RescueInternals;
}

async function* eventsThen(events: AgentStreamEvent[], after?: () => void): AsyncGenerator<AgentStreamEvent> {
  for (const event of events) {
    yield event;
  }
  after?.();
  // Park forever: the abort race (not stream exhaustion) must be what ends
  // the run, mirroring an interrupt landing mid-turn.
  await new Promise<never>(() => {});
  throw new Error('unreachable');
}

describe('classifyProgressSignal — progress vs bookkeeping', () => {
  it('counts model output, tool activity, plan and task lifecycle as progress', () => {
    expect(classifyProgressSignal({ type: 'thought_delta', text: 'hmm' })).toBe('thought_delta');
    expect(classifyProgressSignal({ type: 'assistant_delta', text: '답변' })).toBe('assistant_delta');
    expect(classifyProgressSignal({ type: 'tool_call', toolCallId: 't1', name: 'Read', input: {} })).toBe('tool_call');
    expect(classifyProgressSignal({ type: 'tool_result', toolCallId: 't1', content: [] })).toBe('tool_result');
    expect(classifyProgressSignal({ type: 'plan_update', entries: [{ title: 'step' }] })).toBe('plan_update');
    expect(classifyProgressSignal({ type: 'agent_task_lifecycle', phase: 'started', taskId: 'bg1' })).toBe(
      'agent_task_lifecycle',
    );
  });

  it('does NOT count bookkeeping / terminal frames', () => {
    expect(classifyProgressSignal({ type: 'usage', usage: {} })).toBeUndefined();
    expect(classifyProgressSignal({ type: 'status', status: 'working' })).toBeUndefined();
    expect(classifyProgressSignal({ type: 'compact_boundary', metadata: {} })).toBeUndefined();
    expect(classifyProgressSignal({ type: 'mode_update', modeId: 'plan' })).toBeUndefined();
    expect(classifyProgressSignal({ type: 'result', stopReason: 'end_turn' })).toBeUndefined();
  });

  it('does NOT count an empty assistant_delta (SDK pads tool use with empty text)', () => {
    expect(classifyProgressSignal({ type: 'assistant_delta', text: '' })).toBeUndefined();
    expect(classifyProgressSignal({ type: 'assistant_delta', text: '   \n' })).toBeUndefined();
  });
});

describe('StreamProcessor — heartbeat vs progress callbacks', () => {
  it('fires onSdkActivity for every frame but onProgress only for real work', async () => {
    const onSdkActivity = vi.fn();
    const onProgress = vi.fn();
    const callbacks: StreamCallbacks = { onSdkActivity, onProgress };
    const processor = new AgentStreamProcessor(callbacks);

    const { context } = streamingContext();
    const events: AgentStreamEvent[] = [
      { type: 'usage', usage: {} },
      { type: 'status', status: 'working' },
      { type: 'assistant_delta', text: '' },
      { type: 'tool_call', toolCallId: 't1', name: 'Read', input: {} },
      { type: 'result', stopReason: 'end_turn' },
    ];

    await processor.process(
      (async function* () {
        for (const e of events) yield e;
      })(),
      context,
      new AbortController().signal,
    );

    // Every frame is a sign of life…
    expect(onSdkActivity).toHaveBeenCalledTimes(5);
    // …but only the tool_call moved anything.
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0].type).toBe('tool_call');
    expect(typeof onProgress.mock.calls[0][0].at).toBe('number');
  });

  it('a non-empty assistant_delta is progress; an empty one is heartbeat only', async () => {
    const onSdkActivity = vi.fn();
    const onProgress = vi.fn();
    const processor = new AgentStreamProcessor({ onSdkActivity, onProgress });
    const { context } = streamingContext();

    await processor.process(
      (async function* () {
        yield { type: 'assistant_delta', text: '   ' } as AgentStreamEvent;
        yield { type: 'assistant_delta', text: '실제 답변' } as AgentStreamEvent;
        yield { type: 'result', stopReason: 'end_turn' } as AgentStreamEvent;
      })(),
      context,
      new AbortController().signal,
    );

    expect(onSdkActivity).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0].type).toBe('assistant_delta');
  });

  it('a throwing onProgress cannot break the stream loop', async () => {
    const onProgress = vi.fn(() => {
      throw new Error('callback bug');
    });
    const processor = new AgentStreamProcessor({ onProgress });
    const { context } = streamingContext();

    const result = await processor.process(
      (async function* () {
        yield { type: 'tool_call', toolCallId: 't1', name: 'Read', input: {} } as AgentStreamEvent;
        yield { type: 'result', stopReason: 'end_turn' } as AgentStreamEvent;
      })(),
      context,
      new AbortController().signal,
    );

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe('StreamProcessor — A11 interrupted-text rescue', () => {
  it('flushes assistant text buffered when the explicit interrupt lands (no tool boundary)', async () => {
    const { context, appendText, say } = streamingContext();
    const processor = new AgentStreamProcessor({});
    const abortController = new AbortController();

    // Text arrives and NOTHING closes the render group — the interrupt is the
    // very next thing that happens. Pre-fix this text was dropped: both abort
    // exits return from inside the loop, skipping the post-loop flushAll().
    const result = await processor.process(
      eventsThen([{ type: 'assistant_delta', text: '중간까지 쓴 답변' }], () =>
        abortController.abort('user-interrupted'),
      ),
      context,
      abortController.signal,
    );

    expect(result.aborted).toBe(true);
    expect(appendText).toHaveBeenCalledTimes(1);
    expect(appendText.mock.calls[0][0]).toBe('C1:T1:turn-1');
    expect(appendText.mock.calls[0][1]).toContain('중간까지 쓴 답변');
    // Own turn stream only — never a new message for the interrupted turn.
    expect(say).not.toHaveBeenCalled();
  });

  it('does NOT flush buffered tool calls (a rendered tool call would claim it ran)', async () => {
    const onToolUse = vi.fn().mockResolvedValue(undefined);
    const { context, appendText } = streamingContext();
    const processor = new AgentStreamProcessor({ onToolUse });
    const abortController = new AbortController();

    await processor.process(
      eventsThen(
        [
          { type: 'assistant_delta', text: '조사 시작' },
          { type: 'tool_call', toolCallId: 't1', name: 'Bash', input: { command: 'deploy' } },
        ],
        () => abortController.abort('user-interrupted'),
      ),
      context,
      abortController.signal,
    );

    // The text that preceded the tool call was flushed by the group boundary;
    // the tool call itself stays buffered and is never rendered.
    expect(onToolUse).not.toHaveBeenCalled();
    const appended = appendText.mock.calls.map((c: unknown[]) => c[1]).join('');
    expect(appended).toContain('조사 시작');
    expect(appended).not.toContain('deploy');
  });

  it('leaves other abort reasons on the historical drop path', async () => {
    const { context, appendText, say } = streamingContext();
    const processor = new AgentStreamProcessor({});
    const abortController = new AbortController();

    await processor.process(
      eventsThen([{ type: 'assistant_delta', text: '버려질 텍스트' }], () => abortController.abort('user-stop')),
      context,
      abortController.signal,
    );

    expect(appendText).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('drops the rescue (never opens a new message) when the turn stream is gone', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'm' });
    const context = baseContext({
      turnId: 'C1:T1:turn-1',
      threadPanel: { isTurnSurfaceActive: () => false, appendText: vi.fn() },
      say: say as unknown as StreamContext['say'],
    });
    const processor = new AgentStreamProcessor({});
    const abortController = new AbortController();

    await processor.process(
      eventsThen([{ type: 'assistant_delta', text: '표면 없는 텍스트' }], () =>
        abortController.abort('user-interrupted'),
      ),
      context,
      abortController.signal,
    );

    expect(say).not.toHaveBeenCalled();
  });

  // The rescue exists because losing the user's answer is the failure mode. A
  // rescue that fails is the SAME loss, so it cannot be a debug breadcrumb —
  // the operator needs the Slack code and how much text went missing, and the
  // caller needs a return value instead of an indistinguishable `void`.
  it('warns (not debug) with the Slack code and length when the rescue append rejects', async () => {
    const slackErr = Object.assign(new Error('slack down'), { data: { error: 'ratelimited' } });
    const appendText = vi.fn().mockRejectedValue(slackErr);
    const { context } = streamingContext(appendText);
    const processor = new AgentStreamProcessor({});
    const warnSpy = vi.fn();
    internals(processor).logger.warn = warnSpy;
    const abortController = new AbortController();

    await processor.process(
      eventsThen([{ type: 'assistant_delta', text: '잃어버린 답변' }], () => abortController.abort('user-interrupted')),
      context,
      abortController.signal,
    );

    // One attempt + the single retry the rescue owes the user's answer.
    expect(appendText).toHaveBeenCalledTimes(2);
    const rescueWarn = warnSpy.mock.calls.find((call) => String(call[0]).includes('interrupt flush'));
    expect(rescueWarn).toBeDefined();
    expect(rescueWarn?.[1]).toMatchObject({
      sessionKey: 'C1:T1',
      turnId: 'C1:T1:turn-1',
      length: '잃어버린 답변'.length,
      code: 'ratelimited',
    });
  });

  it('warns when the stream REFUSES the partial text (appendText resolves false)', async () => {
    const appendText = vi.fn().mockResolvedValue(false);
    const { context } = streamingContext(appendText);
    const processor = new AgentStreamProcessor({});
    const warnSpy = vi.fn();
    internals(processor).logger.warn = warnSpy;
    const abortController = new AbortController();

    await processor.process(
      eventsThen([{ type: 'assistant_delta', text: '거절된 답변' }], () => abortController.abort('user-interrupted')),
      context,
      abortController.signal,
    );

    const rescueWarn = warnSpy.mock.calls.find((call) => String(call[0]).includes('interrupt flush'));
    expect(rescueWarn).toBeDefined();
    expect(rescueWarn?.[1]).toMatchObject({ turnId: 'C1:T1:turn-1', length: '거절된 답변'.length });
  });

  it('reports delivery to the caller: delivered when the text landed, not when it was lost', async () => {
    const processor = new AgentStreamProcessor({});
    internals(processor).logger.warn = vi.fn();
    const abortController = new AbortController();
    abortController.abort('user-interrupted');
    const flush = internals(processor).flushTextOnExplicitInterrupt.bind(processor);

    const ok = streamingContext(vi.fn().mockResolvedValue(true));
    await expect(flush(['살아남은 답변'], ok.context, abortController.signal)).resolves.toEqual({ delivered: true });

    const lost = streamingContext(vi.fn().mockRejectedValue(new Error('transport')));
    await expect(flush(['잃어버린 답변'], lost.context, abortController.signal)).resolves.toMatchObject({
      delivered: false,
      failure: { length: '잃어버린 답변'.length },
    });

    const refused = streamingContext(vi.fn().mockResolvedValue(false));
    await expect(flush(['거절된 답변'], refused.context, abortController.signal)).resolves.toMatchObject({
      delivered: false,
      failure: { length: '거절된 답변'.length },
    });
  });

  // The buffer is the ONLY copy of the interrupted answer. Clearing it before
  // Slack accepted the append means a rejected write destroys the text with no
  // second chance — and the caller never learns it happened.
  it('keeps the buffer and reports the loss when BOTH rescue attempts fail', async () => {
    const slackErr = Object.assign(new Error('slack down'), { data: { error: 'ratelimited' } });
    const appendText = vi.fn().mockRejectedValue(slackErr);
    const { context } = streamingContext(appendText);
    const processor = new AgentStreamProcessor({});
    internals(processor).logger.warn = vi.fn();
    const abortController = new AbortController();
    abortController.abort('user-interrupted');

    const textBuf = ['잃어버린 답변'];
    const outcome = await internals(processor).flushTextOnExplicitInterrupt(textBuf, context, abortController.signal);

    expect(appendText).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ delivered: false, failure: { length: '잃어버린 답변'.length, code: 'ratelimited' } });
    // Not destroyed on the way out.
    expect(textBuf).toEqual(['잃어버린 답변']);
  });

  it('a rescue that lands on the RETRY clears the buffer and reports no loss', async () => {
    const appendText = vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValue(true);
    const { context } = streamingContext(appendText);
    const processor = new AgentStreamProcessor({});
    internals(processor).logger.warn = vi.fn();
    const abortController = new AbortController();
    abortController.abort('user-interrupted');

    const textBuf = ['살아남은 답변'];
    const outcome = await internals(processor).flushTextOnExplicitInterrupt(textBuf, context, abortController.signal);

    expect(appendText).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ delivered: true });
    expect(textBuf).toEqual([]);
  });

  it('surfaces the lost rescue on the stream result so the caller can degrade the header', async () => {
    const slackErr = Object.assign(new Error('slack down'), { data: { error: 'ratelimited' } });
    const { context } = streamingContext(vi.fn().mockRejectedValue(slackErr));
    const processor = new AgentStreamProcessor({});
    internals(processor).logger.warn = vi.fn();
    const abortController = new AbortController();

    const result = await processor.process(
      eventsThen([{ type: 'assistant_delta', text: '중간 답변' }], () => abortController.abort('user-interrupted')),
      context,
      abortController.signal,
    );

    expect(result.aborted).toBe(true);
    expect(result.interruptFlushFailed).toEqual({ length: '중간 답변'.length, code: 'ratelimited' });
  });

  it('leaves the stream result clean when the rescue was delivered', async () => {
    const { context } = streamingContext();
    const processor = new AgentStreamProcessor({});
    const abortController = new AbortController();

    const result = await processor.process(
      eventsThen([{ type: 'assistant_delta', text: '중간 답변' }], () => abortController.abort('user-interrupted')),
      context,
      abortController.signal,
    );

    expect(result.interruptFlushFailed).toBeUndefined();
  });

  it('does not leak a transport-error frame (prompt-too-long) as rescued output', async () => {
    const { context, appendText } = streamingContext();
    const processor = new AgentStreamProcessor({});
    const abortController = new AbortController();

    await processor.process(
      eventsThen([{ type: 'assistant_delta', text: 'Prompt is too long' }], () =>
        abortController.abort('user-interrupted'),
      ),
      context,
      abortController.signal,
    );

    expect(appendText).not.toHaveBeenCalled();
  });
});
