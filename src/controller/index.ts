/**
 * Controller Module — Agent orchestration layer (Issue #410)
 */

// Agent provider interface + events
export type {
  AgentErrorEvent,
  AgentEvent,
  AgentInitEvent,
  AgentProvider,
  AgentTextEvent,
  AgentThinkingEvent,
  AgentToolResultEvent,
  AgentToolUseEvent,
  AgentTurnCompleteEvent,
  AgentUsage,
  McpContext,
  PromptContext,
  QueryParams,
} from './agent-provider.js';

// Anthropic implementation
export { AnthropicProvider, type ClaudeHandlerQueryInterface } from './anthropic-provider.js';

// Session controller
export { SessionController, type SessionRegistryLike } from './session-controller.js';
