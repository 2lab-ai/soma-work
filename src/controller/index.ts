/**
 * Controller Module — Agent orchestration layer (Issue #410, #411, #413)
 */

// Agent executor — platform-agnostic turn execution (Issue #411)
export { AgentExecutor, type ExecutionOptions, type ExecutionResult, type ToolCallSummary } from './agent-executor.js';
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
// Message pipeline — platform-agnostic input→execute→respond (Issue #411)
export {
  MessagePipeline,
  type PipelineConfig,
  type PipelineEvent,
  type PipelineEventHandler,
  type PipelineResult,
} from './message-pipeline.js';
// OpenAI implementation (Issue #413)
export { type OpenAIClientInterface, OpenAIProvider } from './openai-provider.js';
// Provider registry — multi-provider management (Issue #413)
export { type ProviderName, ProviderRegistry } from './provider-registry.js';
// Session controller
export { SessionController, type SessionRegistryLike } from './session-controller.js';
