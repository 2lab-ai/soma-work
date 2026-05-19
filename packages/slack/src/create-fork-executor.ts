/**
 * createForkExecutor — Factory for real ForkExecutor using ClaudeHandler
 *
 * Bridges SummaryService's ForkExecutor interface to ClaudeHandler.dispatchOneShot(),
 * which provides single-turn, no-tools LLM queries.
 *
 * The summary prompt is sent as the user message with a minimal system prompt,
 * and the assistant's text response is returned directly.
 */

import { Logger } from '@soma/common/logger';
import type { ForkExecutor } from './summary-service.js';

export interface ForkDispatchHandler {
  dispatchOneShot(
    prompt: string,
    systemPrompt: string,
    model?: string,
    abortController?: AbortController,
    resumeSessionId?: string,
    cwd?: string,
  ): Promise<string>;
}

const logger = new Logger('createForkExecutor');

const FORK_SYSTEM_PROMPT =
  'You generate executive summaries of engineering work sessions from conversation history. ' +
  'The session is forked from a live session — you have full access to all assistant messages, tool calls, tool outputs, and user messages from history. ' +
  'Extract concrete work artifacts from history: file paths edited, commands run, commits made, PR/issue numbers, decisions, errors. Be specific. Never fabricate. Never hedge. ' +
  'You have NO tools or API access. Do NOT attempt to call any tools, fetch URLs, or access external services. ' +
  'If the conversation history is truly empty, say so in one sentence — do NOT ask the user for additional context. ' +
  'Respond with the summary only — no preamble, no markdown fences wrapping the whole response.';

/**
 * Creates a ForkExecutor that delegates to ClaudeHandler.dispatchOneShot().
 *
 * @param claudeHandler - The ClaudeHandler instance that manages SDK queries
 * @returns A ForkExecutor function compatible with SummaryService
 */
export function createForkExecutor(claudeHandler: ForkDispatchHandler): ForkExecutor {
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
        // "No conversation found" from the SDK means our `resume + forkSession`
        // call could not find the session file under `~/.claude/projects/
        // <encoded-cwd>/<sessionId>.jsonl`. Two real causes:
        //   1. cwd passed to dispatchOneShot does NOT match the cwd the
        //      conversation was created under (caller wiring bug).
        //   2. SDK truly expired/cleaned the session file.
        //
        // Issue #231 originally banned context-less summaries because they
        // produce garbage output ("저에게 연결된 리포지토리/이슈가 없습니다…").
        // We previously retried without `sessionId` here as a fallback, which
        // silently resurrected that exact garbage path. Return null instead so
        // the caller skips display and the underlying mismatch surfaces in
        // logs instead of being masked by a misleading summary.
        const msg = firstError instanceof Error ? firstError.message : String(firstError);
        const isStaleSession = sessionId && msg.toLowerCase().includes('no conversation found');

        if (isStaleSession) {
          logger.error(
            'Fork executor: SDK could not load conversation history — refusing to render context-less summary',
            {
              sessionId,
              cwd: cwd ?? 'none',
              error: msg,
              hint: 'Check that cwd passed to fork matches sessionWorkingDir, or that the SDK session file still exists.',
            },
          );
          return null;
        }
        throw firstError;
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
