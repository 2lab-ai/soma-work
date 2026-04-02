/**
 * createForkExecutor — Factory for real ForkExecutor using ClaudeHandler
 *
 * Bridges SummaryService's ForkExecutor interface to ClaudeHandler.dispatchOneShot(),
 * which provides single-turn, no-tools LLM queries.
 *
 * The summary prompt is sent as the user message with a minimal system prompt,
 * and the assistant's text response is returned directly.
 */

import type { ClaudeHandler } from '../claude-handler.js';
import { Logger } from '../logger.js';
import type { ForkExecutor } from './summary-service.js';

const logger = new Logger('createForkExecutor');

const FORK_SYSTEM_PROMPT =
  'You are a concise assistant that generates executive summaries of engineering work sessions. ' +
  'You have access to the full conversation history of this session — use it to understand what was discussed and accomplished. ' +
  'You have NO tools or API access. Do NOT attempt to call any tools, fetch URLs, or access external services. ' +
  'Summarize ONLY based on the conversation history you can see. ' +
  'If the conversation history is empty or unavailable, state that briefly — do NOT ask the user for additional context. ' +
  'Respond only with the summary — no preamble, no markdown fences.';

/**
 * Creates a ForkExecutor that delegates to ClaudeHandler.dispatchOneShot().
 *
 * @param claudeHandler - The ClaudeHandler instance that manages SDK queries
 * @returns A ForkExecutor function compatible with SummaryService
 */
export function createForkExecutor(claudeHandler: ClaudeHandler): ForkExecutor {
  return async (
    prompt: string,
    model?: string,
    sessionId?: string,
    cwd?: string,
    abortSignal?: AbortSignal,
  ): Promise<string | null> => {
    /** Build an AbortController that mirrors the caller's signal. */
    const makeAbortController = (): AbortController | undefined => {
      if (!abortSignal) return undefined;
      const ac = new AbortController();
      if (abortSignal.aborted) {
        ac.abort(abortSignal.reason);
      } else {
        abortSignal.addEventListener('abort', () => ac.abort(abortSignal.reason), { once: true });
      }
      return ac;
    };

    /** Single dispatch attempt. When resumeId is provided, forkSession is enabled. */
    const attempt = async (resumeId?: string): Promise<string> => {
      return claudeHandler.dispatchOneShot(prompt, FORK_SYSTEM_PROMPT, model, makeAbortController(), resumeId, cwd);
    };

    try {
      logger.info('Fork executor: starting summary query', {
        promptLength: prompt.length,
        model: model ?? 'default',
        hasSessionContext: !!sessionId,
        cwd: cwd ?? 'none',
      });

      let response: string;
      try {
        response = await attempt(sessionId);
      } catch (firstError) {
        // If the fork failed because the session no longer exists, retry without fork.
        // Claude SDK returns "No conversation found with session ID: ..." for stale sessions.
        const msg = firstError instanceof Error ? firstError.message : String(firstError);
        const isStaleSession = sessionId && msg.toLowerCase().includes('no conversation found');

        if (isStaleSession) {
          // Short-circuit: if caller already aborted, don't waste a retry
          if (abortSignal?.aborted) {
            throw firstError;
          }
          logger.warn('Fork executor: stale sessionId, retrying without fork', {
            sessionId,
            error: msg,
          });
          try {
            response = await attempt(undefined);
          } catch (fallbackError) {
            logger.error('Fork executor: fallback also failed', {
              originalError: msg,
              fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            });
            throw fallbackError;
          }
        } else {
          throw firstError;
        }
      }

      const trimmed = response.trim();

      if (!trimmed) {
        logger.warn('Fork executor: received empty response from dispatchOneShot');
        return null;
      }

      logger.info('Fork executor: summary generated successfully', {
        responseLength: trimmed.length,
      });

      return trimmed;
    } catch (error) {
      // Distinguish abort (expected cancellation) from real errors to avoid noisy telemetry
      const isAbort = (error instanceof Error && error.name === 'AbortError') || abortSignal?.aborted;
      if (isAbort) {
        logger.info('Fork executor: summary query aborted', { model: model ?? 'default' });
      } else {
        logger.error('Fork executor: failed to generate summary', {
          error: error instanceof Error ? error.message : String(error),
          model: model ?? 'default',
        });
      }
      return null;
    }
  };
}
