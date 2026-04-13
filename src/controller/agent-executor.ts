/**
 * AgentExecutor — Platform-agnostic agent turn execution (Issue #411)
 *
 * Consumes an AgentEvent stream from an AgentProvider and drives
 * a ResponseSession for progressive rendering.
 *
 * This is the clean replacement for the Controller portion of StreamExecutor.
 * StreamExecutor (2603 lines) mixes View rendering (Slack-specific) with
 * Controller orchestration (platform-agnostic). AgentExecutor extracts
 * the Controller side: it knows about agent events and response sessions,
 * but nothing about Slack, Discord, or any specific platform.
 *
 * Responsibilities:
 * - Route AgentEvents to ResponseSession methods
 * - Track token usage across the turn
 * - Handle errors and classify recoverability
 * - Support cancellation via AbortController
 */

import { Logger } from '../logger.js';
import type { ResponseSession } from '../view/response-session.js';
import type { AgentEvent, AgentProvider, AgentUsage, QueryParams } from './agent-provider.js';

// ─── Types ───────────────────────────────────────────────────────

/** Result of a single agent execution turn. */
export interface ExecutionResult {
  /** Whether the turn completed without errors. */
  readonly success: boolean;
  /** Final stop reason from the agent ('end_turn', 'tool_use', 'max_turns', 'error'). */
  readonly stopReason: string;
  /** Token usage for this turn. */
  readonly usage?: AgentUsage;
  /** Agent session ID (for resumption). */
  readonly sessionId?: string;
  /** If the turn failed with a recoverable error, retry after this many ms. */
  readonly retryAfterMs?: number;
  /** Summary of tool calls made during this turn. */
  readonly toolCalls: readonly ToolCallSummary[];
  /** Total text length produced. */
  readonly textLength: number;
}

/** Summary of a single tool call. */
export interface ToolCallSummary {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly durationMs: number;
  readonly isError: boolean;
}

/** Options for agent execution. */
export interface ExecutionOptions {
  /** Callback invoked on each event (for logging, metrics, etc.). */
  readonly onEvent?: (event: AgentEvent) => void;
}

// ─── Implementation ─────────────────────────────────────────────

export class AgentExecutor {
  private logger = new Logger('AgentExecutor');

  constructor(private provider: AgentProvider) {}

  /**
   * Execute a single agent turn.
   *
   * Streams events from the provider and routes them to the response session.
   * Returns a structured result summarizing the turn.
   */
  async execute(
    params: QueryParams,
    responseSession: ResponseSession,
    options?: ExecutionOptions,
  ): Promise<ExecutionResult> {
    const toolCalls: ToolCallSummary[] = [];
    let usage: AgentUsage | undefined;
    let sessionId: string | undefined;
    let stopReason = 'unknown';
    let textLength = 0;
    let retryAfterMs: number | undefined;
    let success = false;

    this.logger.info('Starting agent execution', {
      provider: this.provider.name,
      promptLength: params.prompt.length,
    });

    try {
      const eventStream = this.provider.query(params);

      // Check abort before entering the event loop
      if (params.abortController?.signal.aborted) {
        responseSession.abort('Cancelled by user');
        return {
          success: false,
          stopReason: 'cancelled',
          toolCalls,
          textLength,
        };
      }

      let aborted = false;

      for await (const event of eventStream) {
        // Check abort
        if (params.abortController?.signal.aborted) {
          responseSession.abort('Cancelled by user');
          stopReason = 'cancelled';
          break;
        }

        // Notify listener
        options?.onEvent?.(event);

        // Route event to response session
        switch (event.type) {
          case 'init':
            sessionId = event.sessionId;
            this.logger.info('Agent initialized', { model: event.model, sessionId });
            break;

          case 'text':
            responseSession.appendText(event.text);
            textLength += event.text.length;
            break;

          case 'thinking':
            responseSession.setStatus('thinking', { context: event.text.slice(0, 100) });
            break;

          case 'tool_use':
            responseSession.setStatus('tool', { tool: event.toolName });
            break;

          case 'tool_result':
            toolCalls.push({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              durationMs: event.durationMs,
              isError: event.isError,
            });

            if (event.isError) {
              responseSession.replacePart(`tool-error-${event.toolCallId}`, {
                type: 'status',
                phase: 'error',
                tool: event.toolName,
              });
            }
            break;

          case 'turn_complete':
            stopReason = event.stopReason;
            usage = event.usage;
            sessionId = event.sessionId ?? sessionId;
            success = true;
            break;

          case 'error':
            if (event.isRecoverable) {
              retryAfterMs = event.retryAfterMs;
              stopReason = 'recoverable_error';
              responseSession.setStatus('error', {
                context: `Recoverable error: ${event.error.message}`,
              });
            } else {
              stopReason = 'error';
              responseSession.abort(event.error.message);
              aborted = true;
            }
            break;
        }

        // Exit the event loop after a non-recoverable error
        if (aborted) break;
      }

      // Complete the response session on success
      if (success) {
        await responseSession.complete();
      }
    } catch (error) {
      this.logger.error('Agent execution failed', error);
      stopReason = 'exception';
      responseSession.abort(error instanceof Error ? error.message : String(error));
    }

    const result: ExecutionResult = {
      success,
      stopReason,
      usage,
      sessionId,
      retryAfterMs,
      toolCalls,
      textLength,
    };

    this.logger.info('Agent execution completed', {
      success: result.success,
      stopReason: result.stopReason,
      textLength: result.textLength,
      toolCallCount: result.toolCalls.length,
    });

    return result;
  }
}
