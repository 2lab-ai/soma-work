/**
 * deploy_completed in the stream processor, beyond the happy path covered in
 * src/slack/__tests__/stream-processor.test.ts:
 *   - an attempt that yields no payload reaches the host as a rejection, once;
 *   - a directive still buffered when the turn is cut (abort, interrupt, idle
 *     timeout) is dispatched anyway — the deploy it reports already happened.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import { AgentStreamProcessor, type StreamContext } from '../stream-processor';

const DIRECTIVE = '{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2","after":"abc1234"}';
const PAYLOAD = { repo: 'acme/app', target: 'deploy/dev2', after: 'abc1234', confirmed: true };

function context(overrides: Partial<StreamContext> = {}): StreamContext {
  return {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    incidentAttempt: false,
    say: vi.fn().mockResolvedValue({ ts: 'm' }) as unknown as StreamContext['say'],
    ...overrides,
  };
}

async function* events(list: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
}

/**
 * Yield, run `after`, then park until `signal` aborts: the abort race (not
 * exhaustion) ends the run, and the parked generator then finishes at once, so
 * the processor's `iterator.return()` does not wait out its bound. Without a
 * signal it parks for good (the idle-timeout case).
 */
async function* eventsThen(
  list: AgentStreamEvent[],
  after?: () => void,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
  after?.();
  await new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Yield, then fail the way a broken transport does. */
async function* eventsThenThrow(list: AgentStreamEvent[], error: Error): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
  throw error;
}

describe('AgentStreamProcessor — deploy_completed rejections', () => {
  it('hands an invalid directive to onDeployCompletedRejected once and leaves it visible', async () => {
    const onDeployCompletedDetected = vi.fn().mockResolvedValue(undefined);
    const onDeployCompletedRejected = vi.fn().mockResolvedValue(undefined);
    const ctx = context();
    const bad = '{"type":"deploy_completed","repo":"acme/app","target":"deploy/dev2","after":"nope"}';
    const processor = new AgentStreamProcessor({ onDeployCompletedDetected, onDeployCompletedRejected });

    await processor.process(
      events([
        { type: 'assistant_delta', text: `Deployed.\n${bad}` },
        { type: 'result', stopReason: 'end_turn', finalText: `Deployed.\n${bad}` },
      ]),
      ctx,
      new AbortController().signal,
    );

    expect(onDeployCompletedDetected).not.toHaveBeenCalled();
    expect(onDeployCompletedRejected).toHaveBeenCalledTimes(1);
    expect(onDeployCompletedRejected).toHaveBeenCalledWith(
      [{ problem: 'after must be a 7-40 char hex sha', repo: 'acme/app', target: 'deploy/dev2', after: 'nope' }],
      ctx,
    );
  });

  it('a throwing rejection callback does not break the turn', async () => {
    const onDeployCompletedRejected = vi.fn().mockRejectedValue(new Error('boom'));
    const processor = new AgentStreamProcessor({ onDeployCompletedRejected });
    const result = await processor.process(
      events([{ type: 'assistant_delta', text: '{"type":"deploy_completed", broken' }]),
      context(),
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    expect(onDeployCompletedRejected).toHaveBeenCalledTimes(1);
  });
});

describe('AgentStreamProcessor — deploy_completed still buffered when the turn is cut', () => {
  it.each(['user-stop', 'supersede', 'stall-timeout'])('dispatches it on an abort (%s)', async (reason) => {
    const onDeployCompletedDetected = vi.fn().mockResolvedValue(undefined);
    const processor = new AgentStreamProcessor({ onDeployCompletedDetected });
    const abort = new AbortController();
    const ctx = context();

    const result = await processor.process(
      eventsThen(
        [{ type: 'assistant_delta', text: `Deployed.\n${DIRECTIVE}` }],
        () => abort.abort(reason),
        abort.signal,
      ),
      ctx,
      abort.signal,
    );

    expect(result.aborted).toBe(true);
    expect(onDeployCompletedDetected).toHaveBeenCalledTimes(1);
    expect(onDeployCompletedDetected).toHaveBeenCalledWith(PAYLOAD, ctx);
  });

  it('dispatches it on an explicit interrupt and rescues only the visible text', async () => {
    const onDeployCompletedDetected = vi.fn().mockResolvedValue(undefined);
    const appendText = vi.fn().mockResolvedValue(true);
    const ctx = context({
      turnId: 'C1:T1:turn-1',
      threadPanel: { isTurnSurfaceActive: () => true, appendText } as unknown as StreamContext['threadPanel'],
    });
    const processor = new AgentStreamProcessor({ onDeployCompletedDetected });
    const abort = new AbortController();

    await processor.process(
      eventsThen(
        [{ type: 'assistant_delta', text: `Deployed.\n${DIRECTIVE}` }],
        () => abort.abort('user-interrupted'),
        abort.signal,
      ),
      ctx,
      abort.signal,
    );

    expect(onDeployCompletedDetected).toHaveBeenCalledTimes(1);
    const appended = appendText.mock.calls.map((call) => call[1]).join('');
    expect(appended).toContain('Deployed.');
    expect(appended).not.toContain('deploy_completed');
  });

  it('dispatches it when the stream goes idle and the turn is cut', async () => {
    const onDeployCompletedDetected = vi.fn().mockResolvedValue(undefined);
    const processor = new AgentStreamProcessor({ onDeployCompletedDetected }, { idleTimeoutMs: 20 });

    const result = await processor.process(
      eventsThen([{ type: 'assistant_delta', text: DIRECTIVE }]),
      context(),
      new AbortController().signal,
    );

    expect(result.aborted).toBe(true);
    expect(onDeployCompletedDetected).toHaveBeenCalledTimes(1);
  });

  it('does nothing extra when the buffer holds no directive', async () => {
    const onDeployCompletedDetected = vi.fn();
    const onDeployCompletedRejected = vi.fn();
    const processor = new AgentStreamProcessor({ onDeployCompletedDetected, onDeployCompletedRejected });
    const abort = new AbortController();

    await processor.process(
      eventsThen([{ type: 'assistant_delta', text: 'half an answer' }], () => abort.abort('user-stop'), abort.signal),
      context(),
      abort.signal,
    );

    expect(onDeployCompletedDetected).not.toHaveBeenCalled();
    expect(onDeployCompletedRejected).not.toHaveBeenCalled();
  });

  it('dispatches it when the stream fails with a transport error, then rethrows', async () => {
    const onDeployCompletedDetected = vi.fn().mockResolvedValue(undefined);
    const processor = new AgentStreamProcessor({ onDeployCompletedDetected });
    const ctx = context();

    await expect(
      processor.process(
        eventsThenThrow([{ type: 'assistant_delta', text: `Deployed.\n${DIRECTIVE}` }], new Error('socket hang up')),
        ctx,
        new AbortController().signal,
      ),
    ).rejects.toThrow('socket hang up');

    expect(onDeployCompletedDetected).toHaveBeenCalledTimes(1);
    expect(onDeployCompletedDetected).toHaveBeenCalledWith(PAYLOAD, ctx);
  });
});
