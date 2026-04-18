/**
 * LlmRuntime — Backend adapter interface for the llm MCP server.
 *
 * Each backend (Codex, Gemini) implements this interface to encapsulate
 * its protocol-specific logic (tool names, session ID format, config expansion).
 * The router (llm-mcp-server.ts) delegates to runtimes without backend branches.
 */

// ── Session types ──────────────────────────────────────────

export type Backend = 'codex' | 'gemini';

/**
 * SessionStatus tri-state (D10).
 *   pending   — record exists but backend has not yet confirmed a sessionId
 *   ready     — backendSessionId is durable; resume is permitted
 *   corrupted — mid-transition crash or legacy record; resume rejected
 */
export type SessionStatus = 'pending' | 'ready' | 'corrupted';

/**
 * SessionRecord — Durable session metadata persisted as JSONL (one per line).
 *
 * Invariants (enforced by loader and by mutators):
 *   status === 'ready'     ⇒ backendSessionId !== null
 *   status === 'pending'   ⇒ backendSessionId === null
 *   status === 'corrupted' ⇒ backendSessionId may be either
 */
export interface SessionRecord {
  publicId: string;
  backend: Backend;
  /** null iff status === 'pending'. */
  backendSessionId: string | null;
  model: string;
  cwd?: string;
  /**
   * Config overrides actually applied at spawn, as echoed by runtime.startSession.
   * Threaded into runtime.resumeSession so resume spawns with identical overrides.
   * Legacy records lacking this field are marked `corrupted` at load time.
   */
  resolvedConfig: Record<string, unknown>;
  status: SessionStatus;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

/**
 * SessionStore — Persistence abstraction for session records.
 *
 * All mutations are serialized through a store-internal WriteQueue and
 * use snapshot/rollback on atomicRewrite failure.
 */
export interface SessionStore {
  get(publicId: string): SessionRecord | undefined;

  /** Insert-or-update a full record (used on create + full-rewrite callers). */
  save(record: SessionRecord): Promise<void>;

  /** Partial in-place update; throws if publicId missing. */
  update(publicId: string, patch: Partial<SessionRecord>): Promise<void>;

  /** Refresh updatedAt to prevent TTL expiry on active sessions. */
  touch(publicId: string): Promise<void>;

  updateBackendSessionId(publicId: string, newBackendSessionId: string): Promise<void>;

  delete(publicId: string): Promise<void>;

  /** Remove expired records (24h TTL on updatedAt). */
  prune(): Promise<void>;
}

// ── Runtime interface ──────────────────────────────────────

/**
 * RuntimeCallOptions — Shared call-site options for runtime invocations.
 *
 * `timeoutMs` and `signal` are enforced by the shared watchdog helper,
 * which is the sole cancellation path (runtime.cancel was removed in v8).
 * `resolvedConfig` is the stored config dictionary threaded into resume
 * so the resumed child spawns with identical overrides.
 */
export interface RuntimeCallOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  resolvedConfig?: Record<string, unknown>;
}

export interface StartSessionResult {
  /** Backend-native session ID (Codex threadId / Gemini sessionId). */
  backendSessionId: string;
  content: string;
  /** Echo of the config dictionary actually applied at spawn (D22). */
  resolvedConfig: Record<string, unknown>;
}

export interface ResumeSessionResult {
  backendSessionId: string;
  content: string;
}

export interface RuntimeCapabilities {
  supportsReview: boolean;
  supportsInterrupt: boolean;
  supportsResume: boolean;
  supportsEventStream: boolean;
}

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
   * Start a new chat session. Must echo the applied config dictionary
   * back as `resolvedConfig` so the router can persist it for resume.
   */
  startSession(
    model: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<StartSessionResult>;

  /**
   * Continue an existing session. `opts.resolvedConfig` carries the
   * stored config from the original spawn so the resumed child spawns
   * with identical overrides.
   */
  resumeSession(
    backendSessionId: string,
    prompt: string,
    opts: RuntimeCallOptions,
  ): Promise<ResumeSessionResult>;

  /** Clean shutdown — stop the underlying MCP client process. */
  shutdown(): Promise<void>;
}
