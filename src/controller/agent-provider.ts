/**
 * AgentProvider — Platform-agnostic AI agent interface (Issue #410)
 *
 * Abstracts the underlying AI SDK (Anthropic, OpenAI, etc.) behind
 * a common interface that the Controller pipeline consumes.
 *
 * Each provider implementation handles:
 * - Credential validation
 * - Prompt construction (system prompt, MCP config, plugins)
 * - SDK streaming query execution
 * - Tool permission hooks
 *
 * The Controller never knows which SDK is being used — it only
 * consumes AgentEvent streams and passes them to the View.
 */

// ─── Agent Events ────────────────────────────────────────────────

/**
 * Discriminated union of events emitted during an agent turn.
 * These are SDK-agnostic representations of what the agent is doing.
 */
export type AgentEvent =
  | AgentInitEvent
  | AgentTextEvent
  | AgentThinkingEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentTurnCompleteEvent
  | AgentErrorEvent;

/** SDK initialization complete. */
export interface AgentInitEvent {
  readonly type: 'init';
  readonly model: string;
  readonly sessionId: string;
}

/** Agent produced text output. */
export interface AgentTextEvent {
  readonly type: 'text';
  readonly text: string;
}

/** Agent is thinking (extended thinking / chain-of-thought). */
export interface AgentThinkingEvent {
  readonly type: 'thinking';
  readonly text: string;
}

/** Agent is calling a tool. */
export interface AgentToolUseEvent {
  readonly type: 'tool_use';
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolCallId: string;
}

/** Tool execution completed. */
export interface AgentToolResultEvent {
  readonly type: 'tool_result';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: string;
  readonly isError: boolean;
  readonly durationMs: number;
}

/** Agent turn completed normally. */
export interface AgentTurnCompleteEvent {
  readonly type: 'turn_complete';
  readonly stopReason: string;
  readonly usage?: AgentUsage;
  readonly sessionId?: string;
}

/** Agent encountered an error. */
export interface AgentErrorEvent {
  readonly type: 'error';
  readonly error: Error;
  readonly isRecoverable: boolean;
  readonly retryAfterMs?: number;
}

// ─── Usage Data ──────────────────────────────────────────────────

/** Provider-agnostic token usage data. */
export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreateTokens?: number;
  readonly contextWindow?: number;
  readonly costUsd?: number;
}

// ─── Query Parameters ────────────────────────────────────────────

/** Parameters for a single agent query (turn). */
export interface QueryParams {
  /** The user's prompt text. */
  readonly prompt: string;
  /** Working directory for tool execution. */
  readonly workingDirectory?: string;
  /** Abort signal for cancellation. */
  readonly abortController?: AbortController;
  /** Resume an existing session (session ID). */
  readonly resumeSessionId?: string;
  /** Fork session instead of continuing (for one-shot dispatch). */
  readonly forkSession?: boolean;
  /** Override model for this query. */
  readonly model?: string;
  /** Max number of agent turns before stopping. */
  readonly maxTurns?: number;
  /** Additional provider-specific options. */
  readonly providerOptions?: Record<string, unknown>;
}

/** Context for prompt construction. */
export interface PromptContext {
  /** User-facing system prompt. */
  readonly systemPrompt?: string;
  /** Session persona. */
  readonly persona?: string;
  /** Session workflow type. */
  readonly workflow?: string;
  /** User ID for permission checks. */
  readonly userId?: string;
  /** Channel/conversation context. */
  readonly channelId?: string;
  readonly threadTs?: string;
}

/** Context for MCP server configuration. */
export interface McpContext {
  readonly userId?: string;
  readonly channelId?: string;
  readonly threadTs?: string;
  readonly workingDirectory?: string;
  /** Additional Slack-specific context (will be generalized in Phase 4). */
  readonly platformContext?: Record<string, unknown>;
}

// ─── Provider Interface ──────────────────────────────────────────

/**
 * Agent provider — abstracts AI SDK interactions.
 *
 * Implementations:
 * - AnthropicProvider: Anthropic Claude Agent SDK
 * - OpenAIProvider: OpenAI Agents SDK (Phase 6)
 */
export interface AgentProvider {
  /** Provider name (e.g., 'anthropic', 'openai'). */
  readonly name: string;

  /**
   * Execute a streaming query.
   * Returns an async iterable of AgentEvents.
   * The caller consumes events and routes them to the View.
   */
  query(params: QueryParams, promptCtx?: PromptContext, mcpCtx?: McpContext): AsyncIterable<AgentEvent>;

  /**
   * Execute a one-shot query (no tools, single turn).
   * Used for dispatch classification, summary generation, etc.
   * Returns the complete response text.
   */
  queryOneShot(params: QueryParams, systemPrompt: string): Promise<string>;

  /**
   * Validate that credentials are available and valid.
   * Returns true if the provider can make API calls.
   */
  validateCredentials(): Promise<boolean>;
}
