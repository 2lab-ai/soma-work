/**
 * Agent-runtime port (ADR 0002, pass 1).
 *
 * This file declares the *port* — the SDK-agnostic surface that one-shot
 * caller helpers depend on. It must NOT import any backend SDK (Claude
 * Code, ACP, or otherwise). All backend-specific shapes go through the
 * `extensions` escape hatch and are interpreted by the backend adapter.
 *
 * Pass 1 only covers one-shot text generation (`runOneShotText`). Streaming
 * conversations (driven by `src/claude-handler.ts`) stay on the SDK directly
 * for now and will be moved behind this port in a later pass.
 */

/**
 * Claude-Code-specific extension fields.
 *
 * These have no ACP equivalent (`thinking`, `settingSources`, `plugins`,
 * `stderr`) or are protocol-level rather than agent-input (`env` is how we
 * smuggle the OAuth lease token to the child SDK process). They live in a
 * named bag so callers explicitly declare their dependency on the Claude
 * Code backend.
 *
 * When other backends are introduced, each gets its own named extension
 * bag (e.g. `extensions.acp`). The port itself never grows backend fields.
 */
export interface ClaudeCodeExtensionOptions {
  /** Environment variables forwarded to the SDK child process (OAuth token, etc.). */
  env?: Record<string, string | undefined>;
  /**
   * Adaptive-thinking config; see `buildThinkingOption` in `claude-handler.ts`.
   *
   * One-shot title/summary callers MUST pass `{ type: 'disabled' }`:
   * adaptive thinking on Haiku/Sonnet 4.5 silently consumes the entire
   * output budget on tiny prompts, leaving an empty response that
   * truncates titles to "" or breaks `JSON.parse`. (#762)
   */
  thinking?: unknown;
  /** Claude Code "setting sources" — local plugin directory layering. */
  settingSources?: unknown[];
  /** Plugin directory descriptors. */
  plugins?: unknown[];
  /** Captures stderr from the SDK child process for logging. */
  stderr?: (data: string) => void;
}

/**
 * Portable run options. This is the minimum surface every backend must
 * understand. Backend-specific knobs go through `extensions`.
 */
export interface AgentRunOptions {
  /** Model identifier — both Claude Code and ACP accept opaque model strings. */
  model: string;
  /** Maximum turns for the run. 1-shot helpers always pass `1`. */
  maxTurns?: number;
  /** System prompt for this run (Claude Code: `Options.systemPrompt`; ACP: prompt-turn input). */
  systemPrompt?: string;
  /** Allow-list of tool names. Empty array = no tools. */
  tools?: string[];
  /** Backend-specific extension bags. */
  extensions?: {
    claudeCode?: ClaudeCodeExtensionOptions;
  };
}
