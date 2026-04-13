/**
 * AnthropicProvider — Anthropic Claude Agent SDK implementation (Issue #410)
 *
 * Wraps the existing ClaudeHandler's streamQuery() and dispatchOneShot()
 * methods behind the AgentProvider interface.
 *
 * This is Phase 3's thin adapter approach:
 * - Does NOT restructure ClaudeHandler internals
 * - Delegates to ClaudeHandler for actual SDK calls
 * - Translates SDK messages into AgentEvent stream
 *
 * When Phase 4 (Controller pipeline) is done, ClaudeHandler's query methods
 * will be inlined here and ClaudeHandler will become a pure SessionController.
 */

import { Logger } from '../logger.js';
import type { AgentEvent, AgentProvider, McpContext, PromptContext, QueryParams } from './agent-provider.js';

// ─── Types ───────────────────────────────────────────────────────

/**
 * Minimal interface for ClaudeHandler's query capabilities.
 * Only the methods that AnthropicProvider needs to delegate to.
 */
export interface ClaudeHandlerQueryInterface {
  streamQuery(
    prompt: string,
    session?: any,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: any,
  ): AsyncGenerator<any, void, unknown>;

  dispatchOneShot(
    userMessage: string,
    dispatchPrompt: string,
    model?: string,
    abortController?: AbortController,
    resumeSessionId?: string,
    cwd?: string,
  ): Promise<string>;
}

// ─── Implementation ─────────────────────────────────────────────

export class AnthropicProvider implements AgentProvider {
  private logger = new Logger('AnthropicProvider');
  readonly name = 'anthropic';

  constructor(private claudeHandler: ClaudeHandlerQueryInterface) {}

  /**
   * Stream a multi-turn query through the Claude Agent SDK.
   * Translates SDK messages into AgentEvent objects.
   */
  async *query(params: QueryParams, _promptCtx?: PromptContext, _mcpCtx?: McpContext): AsyncIterable<AgentEvent> {
    this.logger.info('Starting Anthropic query', {
      model: params.model,
      resumeSession: !!params.resumeSessionId,
      promptLength: params.prompt.length,
    });

    try {
      const sdkStream = this.claudeHandler.streamQuery(
        params.prompt,
        undefined, // session — managed by caller
        params.abortController,
        params.workingDirectory,
        undefined, // slackContext — will be generalized in Phase 4
      );

      for await (const message of sdkStream) {
        const events = this.translateSdkMessage(message);
        for (const event of events) {
          yield event;
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
   * Execute a one-shot query (dispatch classification, etc.).
   */
  async queryOneShot(params: QueryParams, systemPrompt: string): Promise<string> {
    return this.claudeHandler.dispatchOneShot(
      params.prompt,
      systemPrompt,
      params.model,
      params.abortController,
      params.resumeSessionId,
      params.workingDirectory,
    );
  }

  /**
   * Validate Anthropic credentials.
   */
  async validateCredentials(): Promise<boolean> {
    // Credential validation is currently embedded in streamQuery/dispatchOneShot.
    // It calls ensureValidCredentials() internally.
    // This will be extracted to a standalone check in Phase 4.
    return true;
  }

  // ─── SDK Message Translation ─────────────────────────────────

  /**
   * Translate a Claude Agent SDK message into an AgentEvent.
   * Returns null for messages that don't map to events.
   */
  private translateSdkMessage(message: any): AgentEvent[] {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          return [
            {
              type: 'init',
              model: message.model || 'unknown',
              sessionId: message.session_id || '',
            },
          ];
        }
        return [];

      case 'assistant': {
        if (!message.message?.content) return [];
        const events: AgentEvent[] = [];
        for (const block of message.message.content) {
          if (block.type === 'text') {
            events.push({ type: 'text', text: block.text });
          }
          if (block.type === 'thinking') {
            events.push({ type: 'thinking', text: block.thinking || '' });
          }
          if (block.type === 'tool_use') {
            events.push({
              type: 'tool_use',
              toolName: block.name || 'unknown',
              toolInput: block.input,
              toolCallId: block.id || '',
            });
          }
        }
        return events;
      }

      case 'tool': {
        if (!message.message?.content) return [];
        const events: AgentEvent[] = [];
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            events.push({
              type: 'tool_result',
              toolCallId: block.tool_use_id || '',
              toolName: '',
              result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              isError: block.is_error || false,
              durationMs: 0,
            });
          }
        }
        return events;
      }

      case 'result':
        return [
          {
            type: 'turn_complete',
            stopReason: message.subtype === 'success' ? message.stop_reason || 'end_turn' : 'error',
            usage: message.usage
              ? {
                  inputTokens: message.usage.input_tokens || 0,
                  outputTokens: message.usage.output_tokens || 0,
                  cacheReadTokens: message.usage.cache_read_input_tokens,
                  cacheCreateTokens: message.usage.cache_creation_input_tokens,
                  contextWindow: message.usage.context_window,
                }
              : undefined,
            sessionId: message.session_id,
          },
        ];

      default:
        return [];
    }
  }

  // ─── Error Classification ────────────────────────────────────

  private isRecoverableError(error: any): boolean {
    const msg = String(error?.message || '');
    return msg.includes('overloaded') || msg.includes('rate_limit') || msg.includes('529') || msg.includes('503');
  }

  private getRetryAfterMs(error: any): number | undefined {
    const msg = String(error?.message || '');
    const match = msg.match(/retry.+?(\d+)\s*s/i);
    if (match) return parseInt(match[1], 10) * 1000;
    if (this.isRecoverableError(error)) return 5000;
    return undefined;
  }
}
