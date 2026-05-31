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
  /** Mirrors `streamProcessorProviders.calculateTokenCost` (injected → pure). */
  calculateTokenCost: CalculateTokenCost;
}

/**
 * Map a Claude SDK message stream into the neutral event stream.
 *
 * A single mapper instance is created per call so its cross-message state
 * (`lastAssistantModelName`, used by the direct-usage cost fallback) is scoped
 * to one turn — exactly as `StreamProcessor`'s per-turn fields were.
 *
 * Back-pressure / cancellation propagate naturally: this generator pulls the
 * next SDK message only when the consumer pulls the next event, and a consumer
 * `return()` (e.g. the processor's bounded iterator-return after `result`)
 * closes the underlying SDK iterator via the `for await` cleanup.
 */
export async function* runAgentStreamFromSdk(
  sdkStream: AsyncIterable<SDKMessage>,
  deps: StreamRunnerDeps,
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  const mapper = createSdkMessageMapper({ calculateTokenCost: deps.calculateTokenCost });
  for await (const message of sdkStream) {
    for (const event of mapper.map(message)) {
      yield event;
    }
  }
}
