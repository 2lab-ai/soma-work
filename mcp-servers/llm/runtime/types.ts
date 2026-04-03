/**
 * LlmRuntime — Backend adapter interface for LLM MCP server.
 *
 * Each backend (Codex, Gemini) implements this interface to encapsulate
 * its protocol-specific logic (tool names, session ID format, config expansion).
 * The router (llm-mcp-server.ts) delegates to runtimes without backend branches.
 *
 * @see Issue #332 — Backend Runtime Adapter Layer
 */

// ── Types ───────────────────────────────────────────────────

/**
 * SessionRecord — Durable session metadata stored by the router.
 * Decouples the public session ID (app-owned UUID) from the backend-native ID.
 * @see Issue #333 — Durable Session Store
 */
export interface SessionRecord {
  publicId: string;          // app-owned UUID (decoupled from backend)
  backend: Backend;
  backendSessionId: string;  // codex threadId or gemini sessionId
  model: string;
  createdAt: string;         // ISO timestamp
  updatedAt: string;         // ISO timestamp
}

/**
 * SessionStore — Persistence abstraction for session records.
 * @see Issue #333 — Durable Session Store
 */
export interface SessionStore {
  get(publicId: string): SessionRecord | undefined;
  save(record: SessionRecord): void;
  /** Refresh updatedAt to prevent TTL expiry on active sessions. */
  touch(publicId: string): void;
  updateBackendSessionId(publicId: string, newBackendSessionId: string): void;
  delete(publicId: string): void;
  prune(): void;  // remove expired sessions
}

export type Backend = 'codex' | 'gemini';

export interface SessionOptions {
  model: string;
  cwd?: string;
  /** User-provided config overrides (already in correct format). */
  config?: Record<string, unknown>;
  /** Backend-specific defaults from routing config (e.g. Codex reasoning_effort). */
  configOverride?: Record<string, string>;
}

export interface SessionResult {
  /** Backend-native session ID (threadId for Codex, sessionId for Gemini). */
  backendSessionId: string;
  content: string;
  backend: Backend;
  model: string;
}

export interface RuntimeCapabilities {
  supportsReview: boolean;       // #337
  supportsInterrupt: boolean;    // #334
  supportsResume: boolean;       // always true for now
  supportsEventStream: boolean;  // #336
}

// ── Interface ───────────────────────────────────────────────

export interface LlmRuntime {
  readonly name: Backend;
  readonly capabilities: RuntimeCapabilities;

  /**
   * Ensure the runtime is ready. Idempotent and single-flight:
   * - Reuses a live client.
   * - Recreates a dead one.
   * - Concurrent calls share the same initialization promise.
   */
  ensureReady(): Promise<void>;

  /**
   * Start a new chat session.
   * The runtime does NOT store sessions — it returns backendSessionId
   * for the router to track in its own session map.
   */
  startSession(prompt: string, options: SessionOptions): Promise<SessionResult>;

  /**
   * Continue an existing session.
   * Takes backendSessionId directly (router owns the public→backend mapping).
   */
  resumeSession(backendSessionId: string, prompt: string): Promise<SessionResult>;

  /** Clean shutdown — stop the underlying MCP client process. */
  shutdown(): Promise<void>;
}
