/**
 * Agent-runtime dispatcher (ADR 0002, pass 1).
 *
 * Currently there is exactly one adapter (Claude Code SDK). The dispatcher
 * exists so callers don't grow a switch over backends — when ACP lands,
 * the dispatch decision moves here, not into every helper.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunOptions } from './agent-runner';
import { runAgentStreamFromSdk, type StreamRunnerDeps } from './claude-code/stream-runner';
import { runOneShotTextClaudeCode } from './claude-code-runner';
import type { AgentStreamEvent } from './stream-types';

/**
 * Run a 1-turn text completion via the active backend.
 *
 * Pass 1 routes unconditionally to the Claude Code SDK adapter. Pass-2+
 * will introduce a runtime selector (env var / config flag) once a second
 * adapter exists. Until then this is a thin call-through so callers depend
 * on the port — not on the SDK module.
 */
export async function runOneShotText(prompt: string, options: AgentRunOptions): Promise<string> {
  return runOneShotTextClaudeCode(prompt, options);
}

/**
 * Streaming agent dispatcher (ADR 0002 pass 2, epic #1023 P4) — the seam the
 * Slack streaming pipeline consumes instead of `SDKMessage`.
 *
 * Track A routes unconditionally to the `claude-sdk` backend
 * (`runAgentStreamFromSdk`), which maps the caller-supplied SDK message stream
 * to neutral `AgentStreamEvent`s. When ACP lands (Track B P8) the backend
 * selection (`SOMA_AGENT_BACKEND`) moves here — callers keep depending on this
 * neutral surface, not on a backend.
 *
 * The SDK message stream is passed in (rather than created here) so lease/auth
 * stays in `ClaudeHandler.streamQuery`; see `claude-code/stream-runner.ts`.
 */
export function runAgentStream(
  sdkStream: AsyncIterable<SDKMessage>,
  deps: StreamRunnerDeps,
): AsyncIterable<AgentStreamEvent> {
  return runAgentStreamFromSdk(sdkStream, deps);
}
