/**
 * LlmRuntime — Backend adapter interface for the llm MCP server.
 *
 * Each backend (Codex, Gemini) implements this interface to encapsulate
 * its protocol-specific logic (tool names, session ID format).
 * The router (llm-mcp-server.ts) delegates to runtimes without backend branches.
 */

export type Backend = 'codex' | 'gemini';

/**
 * RuntimeCallOptions — Shared call-site options for runtime invocations.
 *
 * `timeoutMs` and `signal` are enforced by the shared watchdog helper.
 */
export interface RuntimeCallOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StartSessionResult {
  /** Backend-native session ID (Codex threadId / Gemini sessionId). */
  backendSessionId: string;
  content: string;
}

export interface ResumeSessionResult {
  backendSessionId: string;
  content: string;
}

export interface LlmRuntime {
  readonly name: Backend;

  /**
   * Ensure the runtime is ready. Idempotent and single-flight:
   * reuses a live client, recreates a dead one, concurrent calls share
   * the same initialization promise.
   */
  ensureReady(): Promise<void>;

  /** Start a new chat session. */
  startSession(
    model: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<StartSessionResult>;

  /** Continue an existing backend session. */
  resumeSession(
    backendSessionId: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<ResumeSessionResult>;

  /** Clean shutdown — stop the underlying MCP client process. */
  shutdown(): Promise<void>;
}
