/**
 * Claude SDK streaming runner (ADR 0002 pass 2, epic #1023 P4).
 *
 * The `claude-sdk` backend of the streaming seam. It owns the boundary between
 * the SDK's `query()` output (`AsyncIterable<SDKMessage>`) and the neutral
 * `AgentStreamEvent` stream that the P4 `AgentStreamProcessor` consumes: it
 * drives an `SdkMessageMapper` (P3) over the SDK messages and re-emits the
 * mapped events in order.
 *
 * It deliberately does NOT own lease acquisition / auth / `query()` itself —
 * that stays in `ClaudeHandler.streamQuery`, which already manages the CCT slot
 * lease lifecycle. App wiring composes the two: it passes
 * `claudeHandler.streamQuery(...)` in as `sdkStream`, so this runner is a pure,
 * testable transport mapper with no SDK-process or credential concerns.
 *
 * Adapter zone: may import the SDK `SDKMessage` type (type-only).
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStreamEvent } from '../stream-types';
import { type CalculateTokenCost, createSdkMessageMapper } from './sdk-message-to-event';

export interface StreamRunnerDeps {
  /** Cost function, injected so the mapper stays pure. */
  calculateTokenCost: CalculateTokenCost;
  /** Models the host prices itself (`SdkMessageMapperDeps.hostPriced`). */
  hostPriced?: (model: string) => boolean;
}

/**
 * Map a Claude SDK message stream into the neutral event stream.
 *
 * A single mapper instance is created per call so its cross-message state
 * (`lastAssistantModelName`, used by the direct-usage cost fallback) is scoped
 * to one turn — exactly as `StreamProcessor`'s per-turn fields were.
 *
 * Back-pressure / cancellation: the next SDK message is pulled only when the consumer pulls the next event, and a
 * consumer `return()` closes the SDK iterator at once — also while a `next()` is still waiting for a message
 * (#1473). An async generator could not: its `return()` waits behind the pending `next()`, so a reader that
 * stopped while the CLI was quiet (a Stop, an idle timeout) never reached the stream it read — and the turn's loop,
 * running ahead of the reader (`runAhead`), never heard that nobody reads it any more (round 4, astra).
 */
export function runAgentStreamFromSdk(
  sdkStream: AsyncIterable<SDKMessage>,
  deps: StreamRunnerDeps,
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  const mapper = createSdkMessageMapper({ calculateTokenCost: deps.calculateTokenCost, hostPriced: deps.hostPriced });
  let source: AsyncIterator<SDKMessage> | undefined;
  const sourceOf = () => {
    source ??= sdkStream[Symbol.asyncIterator]();
    return source;
  };
  const mapped: AgentStreamEvent[] = [];
  /** The stream ended, failed or was closed: nothing more is read. */
  let finished = false;
  const done = (): IteratorResult<AgentStreamEvent, void> => ({ done: true, value: undefined });

  const iterator = {
    async next(): Promise<IteratorResult<AgentStreamEvent, void>> {
      for (;;) {
        const event = mapped.shift();
        if (event) return { done: false, value: event };
        if (finished) return done();
        let step: IteratorResult<SDKMessage>;
        try {
          step = await sourceOf().next();
        } catch (error) {
          finished = true;
          throw error;
        }
        // Closed while this read waited: what it brought has no reader.
        if (finished) return done();
        if (step.done) {
          finished = true;
          return done();
        }
        mapped.push(...mapper.map(step.value));
      }
    },
    async return(): Promise<IteratorResult<AgentStreamEvent, void>> {
      if (finished) return done();
      finished = true;
      mapped.length = 0;
      // Not behind a pending `next()`: the source hears it now. Never started: there is nothing to close.
      if (source) await source.return?.(undefined);
      return done();
    },
    async throw(error: unknown): Promise<IteratorResult<AgentStreamEvent, void>> {
      await iterator.return();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  } as AsyncGenerator<AgentStreamEvent, void, unknown>;
  return iterator;
}
