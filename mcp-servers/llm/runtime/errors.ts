/**
 * Typed error contract for the llm MCP server.
 *
 * Machine-readable `code` travels through `structuredContent.error.code`
 * so callers can branch without regex-matching error strings.
 */

export enum ErrorCode {
  INVALID_ARGS = 'invalid_args',
  MUTUAL_EXCLUSION = 'mutual_exclusion',
  SESSION_NOT_FOUND = 'session_not_found',
  SESSION_BUSY = 'session_busy',
  SESSION_CORRUPTED = 'session_corrupted',
  BACKEND_FAILED = 'backend_failed',
  BACKEND_TIMEOUT = 'backend_timeout',
  PERSISTENCE_FAILED = 'persistence_failed',
  ABORTED = 'aborted',
}

export class LlmChatError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'LlmChatError';
  }
}

export function isLlmChatError(e: unknown): e is LlmChatError {
  return e instanceof LlmChatError;
}
