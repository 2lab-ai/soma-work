/**
 * Builder for the canonical one-shot `AgentRunOptions` shape (ADR 0002,
 * pass 1.5).
 *
 * The 5 one-shot call sites in `src/conversation/*.ts` and
 * `src/slack/z/topics/memory-improve.ts` all construct nearly the same
 * shape: `{model, maxTurns:1, tools:[], systemPrompt, extensions:{
 *   claudeCode:{env, settingSources:[], plugins:[], thinking:{type:'disabled'},
 *   stderr: ...}}}`. Pass 1 (PR #975) left this duplication in place to
 * keep the boundary refactor reviewable; this pass extracts it.
 *
 * Out of scope for this builder:
 *   • Lease acquisition / release. `generateSessionSummaryTitle` reuses one
 *     lease across a Haiku→Sonnet fallback, and each helper has a slightly
 *     different `NoHealthySlotError` failure contract. Codex consult
 *     7d938b68-fb6d-4786-a63c.
 *   • The `runOneShotText` call itself. Callers do their own post-processing
 *     (JSON parsing, markdown stripping, slicing) on the returned string.
 */

import type { AgentRunOptions } from './agent-runner';

/**
 * Structural logger interface — the project's `Logger` (in
 * `packages/common/src/logger.ts`) satisfies this. Kept local so the
 * agent-runtime package doesn't import the concrete `Logger` class.
 *
 * Note: `packages/process-shared/src/stderr-logger.ts` ships a wider
 * `LoggerInterface` (debug/info/warn/error). We deliberately narrow to
 * `warn` here because that's the only method the builder uses, and
 * `src/` has no other runtime imports from `@soma/process-shared`. A
 * future consolidation PR could promote a single shared logger interface
 * to `@soma/common`; this is one of ~5 structural logger duplicates
 * across the repo.
 */
export interface LoggerLike {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface BuildOneShotOptionsInput {
  /** Model identifier (e.g. `'claude-haiku-4-5'`). */
  model: string;
  /** System prompt for the run. */
  systemPrompt: string;
  /** Environment variables forwarded to the SDK child (OAuth lease token). */
  env: Record<string, string | undefined>;
  /** Logger used to surface SDK child-process stderr lines. */
  logger: LoggerLike;
  /** Prefix for the stderr log message — emitted as `'${label} stderr'`. */
  stderrLabel: string;
  /**
   * Disable adaptive thinking on the run. Defaults to `true` — see
   * `ClaudeCodeExtensionOptions.thinking` for the #762 rationale (adaptive
   * thinking on tiny title/summary prompts silently eats the output
   * budget). Set to `false` only when the caller deliberately preserves
   * SDK-default adaptive behaviour (currently only `memory-improve.ts`).
   */
  disableThinking?: boolean;
}

/**
 * Build a canonical one-shot `AgentRunOptions`.
 *
 * Notes preserved from inline call sites (do not silently change):
 *   • `tools: []` — one-shot calls never invoke tools.
 *   • `settingSources: []`, `plugins: []` — no local Claude-Code plugin layering.
 *   • `env` is passed by reference (no shallow clone) — matches inline behaviour.
 *   • `stderr` trims the trailing newline before forwarding to the logger.
 */
export function buildOneShotOptions(input: BuildOneShotOptionsInput): AgentRunOptions {
  const { model, systemPrompt, env, logger, stderrLabel, disableThinking = true } = input;
  return {
    model,
    maxTurns: 1,
    tools: [],
    systemPrompt,
    extensions: {
      claudeCode: {
        env,
        settingSources: [],
        plugins: [],
        thinking: disableThinking ? { type: 'disabled' } : undefined,
        stderr: (data: string) => {
          logger.warn(`${stderrLabel} stderr`, { data: data.trimEnd() });
        },
      },
    },
  };
}
