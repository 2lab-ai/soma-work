/**
 * Public surface of the agent-runtime port (ADR 0002).
 *
 * Helpers should import from this index — not from `./claude-code-runner`
 * or `./runner` directly — so that the dispatch decision stays internal.
 */

export type { AgentRunOptions, ClaudeCodeExtensionOptions } from './agent-runner';
export type { StreamRunnerDeps } from './claude-code/stream-runner';
export { type BuildOneShotOptionsInput, buildOneShotOptions, type LoggerLike } from './one-shot-options';
export { runAgentStream, runOneShotText } from './runner';
export type {
  AgentContent,
  AgentStopReason,
  AgentStreamEvent,
  AgentStreamEventOf,
  AgentToolKind,
  AgentToolStatus,
  AgentUsage,
} from './stream-types';
