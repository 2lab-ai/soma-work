/**
 * Agent-runtime dispatcher (ADR 0002, pass 1).
 *
 * Currently there is exactly one adapter (Claude Code SDK). The dispatcher
 * exists so callers don't grow a switch over backends — when ACP lands,
 * the dispatch decision moves here, not into every helper.
 */

import type { AgentRunOptions } from './agent-runner';
import { runOneShotTextClaudeCode } from './claude-code-runner';

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
