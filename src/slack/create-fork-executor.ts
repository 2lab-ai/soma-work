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
import type { ForkExecutor } from './summary-service.js';
import { Logger } from '../logger.js';

const logger = new Logger('createForkExecutor');

const FORK_SYSTEM_PROMPT =
  'You are a concise assistant that generates executive summaries of engineering work sessions. ' +
  'Respond only with the summary — no preamble, no markdown fences.';

/**
 * Creates a ForkExecutor that delegates to ClaudeHandler.dispatchOneShot().
 *
 * @param claudeHandler - The ClaudeHandler instance that manages SDK queries
 * @returns A ForkExecutor function compatible with SummaryService
 */
export function createForkExecutor(claudeHandler: ClaudeHandler): ForkExecutor {
  return async (prompt: string, model?: string, sessionId?: string, cwd?: string, abortSignal?: AbortSignal): Promise<string | null> => {
    try {
      logger.info('Fork executor: starting summary query', {
        promptLength: prompt.length,
        model: model ?? 'default',
        hasSessionContext: !!sessionId,
        cwd: cwd ?? 'none',
      });

      // Thread AbortSignal → AbortController for dispatchOneShot compatibility.
      // If caller provided a signal, wrap it; otherwise pass undefined.
      let abortController: AbortController | undefined;
      if (abortSignal) {
        abortController = new AbortController();
        // Forward external abort to our controller
        if (abortSignal.aborted) {
          abortController.abort(abortSignal.reason);
        } else {
          abortSignal.addEventListener('abort', () => {
            abortController!.abort(abortSignal.reason);
          }, { once: true });
        }
      }

      const response = await claudeHandler.dispatchOneShot(
        prompt,
        FORK_SYSTEM_PROMPT,
        model,
        abortController,
        sessionId, // fork session for conversation context
        cwd,       // working directory for forked session
      );

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
