/**
 * OpenAIProvider — OpenAI Responses API implementation (Issue #413)
 *
 * Implements AgentProvider for OpenAI models (GPT-4o, o3, etc.)
 * using the OpenAI Responses API with streaming.
 *
 * This is Phase 6's thin adapter approach:
 * - Defines OpenAIClientInterface for dependency injection
 * - Translates OpenAI streaming events to AgentEvent
 * - Does NOT add openai SDK dependency — caller provides the client
 *
 * OpenAI Responses API event types mapped to AgentEvent:
 *   response.created        → init
 *   response.output_text.delta → text
 *   response.function_call_arguments.delta → (accumulated)
 *   response.output_item.done (function_call) → tool_use
 *   response.completed      → turn_complete
 *   error                   → error
 *
 * When the OpenAI SDK is installed, wire it like:
 *   const openai = new OpenAI({ apiKey });
 *   const provider = new OpenAIProvider({
 *     stream: (params) => openai.responses.stream(params),
 *     create: (params) => openai.responses.create(params),
 *   });
 */

import { Logger } from '../logger.js';
import type { AgentEvent, AgentProvider, McpContext, PromptContext, QueryParams } from './agent-provider.js';

// ─── Types ───────────────────────────────────────────────────────

/**
 * Minimal interface for OpenAI client capabilities.
 * Caller provides this — no direct openai SDK dependency needed.
 */
export interface OpenAIClientInterface {
  /**
   * Create a streaming response.
   * Returns an async iterable of OpenAI streaming events.
   */
  stream(params: OpenAIStreamParams): AsyncIterable<OpenAIStreamEvent>;

  /**
   * Create a non-streaming response (for one-shot queries).
   */
  create(params: OpenAICreateParams): Promise<OpenAIResponse>;
}

/** Parameters for OpenAI streaming response. */
export interface OpenAIStreamParams {
  model: string;
  input: string;
  instructions?: string;
  tools?: OpenAITool[];
  previousResponseId?: string;
  stream: true;
}

/** Parameters for OpenAI non-streaming response. */
export interface OpenAICreateParams {
  model: string;
  input: string;
  instructions?: string;
}

/** OpenAI tool definition. */
export interface OpenAITool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** OpenAI streaming event (simplified). */
export interface OpenAIStreamEvent {
  type: string;
  /** For response.created */
  response?: {
    id: string;
    model: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  /** For text deltas */
  delta?: string;
  /** For output_item.done */
  item?: {
    type: string;
    id?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  /** For errors */
  error?: {
    message: string;
    code?: string;
  };
}

/** OpenAI non-streaming response. */
export interface OpenAIResponse {
  id: string;
  output: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ─── Default Model ──────────────────────────────────────────────

const DEFAULT_OPENAI_MODEL = 'gpt-4o';

// ─── Implementation ─────────────────────────────────────────────

export class OpenAIProvider implements AgentProvider {
  private logger = new Logger('OpenAIProvider');
  private functionCallArgs = new Map<string, string>();
  readonly name = 'openai';

  constructor(
    private client: OpenAIClientInterface,
    private defaultModel: string = DEFAULT_OPENAI_MODEL,
  ) {}

  /**
   * Stream a query through the OpenAI Responses API.
   * Translates OpenAI events into AgentEvent objects.
   */
  async *query(params: QueryParams, _promptCtx?: PromptContext, _mcpCtx?: McpContext): AsyncIterable<AgentEvent> {
    this.logger.info('Starting OpenAI query', {
      model: params.model || this.defaultModel,
      promptLength: params.prompt.length,
    });

    try {
      const streamParams: OpenAIStreamParams = {
        model: params.model || this.defaultModel,
        input: params.prompt,
        previousResponseId: params.resumeSessionId,
        stream: true,
      };

      const eventStream = this.client.stream(streamParams);

      for await (const event of eventStream) {
        const agentEvent = this.translateEvent(event);
        if (agentEvent) {
          yield agentEvent;
        }
      }
    } catch (error) {
      yield {
        type: 'error' as const,
        error: error instanceof Error ? error : new Error(String(error)),
        isRecoverable: this.isRecoverableError(error),
        retryAfterMs: this.getRetryAfterMs(error),
      };
    }
  }

  /**
   * Execute a one-shot query (no tools, single turn).
   */
  async queryOneShot(params: QueryParams, systemPrompt: string): Promise<string> {
    const response = await this.client.create({
      model: params.model || this.defaultModel,
      input: params.prompt,
      instructions: systemPrompt,
    });

    // Extract text from response output
    for (const item of response.output) {
      if (item.type === 'message' && item.content) {
        for (const block of item.content) {
          if (block.type === 'output_text' && block.text) {
            return block.text;
          }
        }
      }
    }

    return '';
  }

  /**
   * Validate OpenAI credentials.
   */
  async validateCredentials(): Promise<boolean> {
    // Will be implemented with actual API check when SDK is added
    return true;
  }

  // ─── Event Translation ──────────────────────────────────────

  private translateEvent(event: OpenAIStreamEvent): AgentEvent | null {
    switch (event.type) {
      case 'response.created':
        if (event.response) {
          return {
            type: 'init',
            model: event.response.model,
            sessionId: event.response.id,
          };
        }
        return null;

      case 'response.output_text.delta':
        if (event.delta) {
          return { type: 'text', text: event.delta };
        }
        return null;

      case 'response.function_call_arguments.delta':
        // Accumulate function call arguments for later use
        if (event.item?.call_id && event.delta) {
          const existing = this.functionCallArgs.get(event.item.call_id) || '';
          this.functionCallArgs.set(event.item.call_id, existing + event.delta);
        }
        return null;

      case 'response.output_item.done':
        if (event.item?.type === 'function_call') {
          const callId = event.item.call_id || event.item.id || '';
          const args = event.item.arguments || this.functionCallArgs.get(callId) || '';
          this.functionCallArgs.delete(callId); // Clean up
          return {
            type: 'tool_use',
            toolName: event.item.name || 'unknown',
            toolInput: this.parseToolInput(args),
            toolCallId: callId,
          };
        }
        return null;

      case 'response.completed':
        return {
          type: 'turn_complete',
          stopReason: 'end_turn',
          usage: event.response?.usage
            ? {
                inputTokens: event.response.usage.input_tokens,
                outputTokens: event.response.usage.output_tokens,
              }
            : undefined,
          sessionId: event.response?.id,
        };

      case 'error':
        return {
          type: 'error',
          error: new Error(event.error?.message || 'Unknown OpenAI error'),
          isRecoverable: this.isRecoverableErrorCode(event.error?.code),
          retryAfterMs: this.isRecoverableErrorCode(event.error?.code) ? 5000 : undefined,
        };

      default:
        return null;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  private parseToolInput(args?: string): unknown {
    if (!args) return {};
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }

  private isRecoverableError(error: unknown): boolean {
    const msg = String((error as any)?.message || '');
    return msg.includes('rate_limit') || msg.includes('429') || msg.includes('503') || msg.includes('overloaded');
  }

  private isRecoverableErrorCode(code?: string): boolean {
    if (!code) return false;
    return code === 'rate_limit_exceeded' || code === 'server_error';
  }

  private getRetryAfterMs(error: unknown): number | undefined {
    if (this.isRecoverableError(error)) return 5000;
    return undefined;
  }
}
