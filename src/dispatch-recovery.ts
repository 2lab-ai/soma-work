/**
 * Recovery decisions for one-shot dispatches (`ClaudeHandler.dispatchOneShot`).
 *
 * The one-shot seam serves the goal-completion eval, workflow-dispatch
 * classification, the safety classifier and the summarizer helpers. Unlike the
 * streaming turn path (stream-executor), it historically had NO recovery for
 * two transient failure classes, so a single flake killed the caller:
 *
 *   - `529 overloaded_error` → the goal loop stopped with "eval failed —
 *     manual `goal done` required"; workflow dispatch fell back to [default].
 *   - `Prompt is too long` → same, even though the streaming path has had an
 *     auto fallback-compact cure since #1198/#1200.
 *
 * This module ports the EXISTING recovery patterns onto the one-shot seam:
 *
 *   - Overloaded/529 → wait 30s and retry (mirrors StreamExecutor's
 *     `ERROR_RETRY_DELAY_MS = 30_000` / `MAX_ERROR_RETRIES = 3` policy).
 *   - Prompt-too-long → retry once on the 1M-window fallback compact model
 *     (`AUTO_FALLBACK_COMPACT_MODEL`, default `opus[1m]`). A one-shot has no
 *     session history to `/compact`, so the model-window switch IS the whole
 *     cure — the same first half of the streaming fallback-compact recovery
 *     (`applyAutoFallbackCompact` in stream-executor).
 *
 * Decisions are pure (`decideDispatchRetry`) so the retry policy is unit-
 * testable without standing up leases / the SDK; the loop wiring lives in
 * `claude-handler.ts`.
 */

import { config } from './config';
import { hasOneMSuffix, resolveContextWindow } from './metrics/model-registry';
import { coerceToAvailableModel } from './user-settings-store';

/**
 * Max retries when a one-shot dispatch throws an overloaded/529 API error.
 * Mirrors StreamExecutor.MAX_ERROR_RETRIES.
 */
export const DISPATCH_OVERLOADED_MAX_RETRIES = 3;

/**
 * Delay before each overloaded/529 retry. Mirrors
 * StreamExecutor.ERROR_RETRY_DELAY_MS (the streaming path's recoverable-error
 * backoff) — and the explicit ops request: "529는 30초 대기후 재시도".
 */
export const DISPATCH_OVERLOADED_RETRY_DELAY_MS = 30_000;

/**
 * Anthropic-overload signal in an ERROR payload (message/stderr — never turn
 * content). Matches both the JSON error type (`overloaded_error` /
 * "Overloaded") and raw HTTP-status shapes ("API Error: 529").
 * `\b529\b` is safe here because the input is an error string, not prose.
 */
export function isOverloadedErrorText(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes('overloaded') || /\b529\b/.test(t);
}

/**
 * Context-overflow signal in an ERROR payload. Same three signals as
 * StreamExecutor.isContextOverflowError so the two seams can never diverge.
 */
export function isContextOverflowErrorText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('prompt is too long') || t.includes('context length exceeded') || t.includes('maximum context length')
  );
}

/**
 * Detect a context-overflow error that surfaced as the one-shot's assistant
 * TEXT with a successful result (SDK isError=false, nothing throws) — the
 * same field bug class as #1200. Deliberately narrow to avoid false positives
 * on outputs that legitimately DISCUSS overflow errors: the text must be
 * SHORT (an error string, not prose) AND match the overflow signals.
 */
export function textIndicatesPromptTooLongContent(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 160) return false;
  return isContextOverflowErrorText(t);
}

/** Mutable retry bookkeeping the dispatch loop threads through decisions. */
export interface DispatchRetryState {
  /** Overloaded/529 retries already consumed in this dispatch. */
  overloadedRetries: number;
  /** Whether the 1M fallback-model retry was already spent. */
  overflowFallbackUsed: boolean;
  /** Model the failing attempt ran on (undefined/'' → SDK default). */
  model: string | undefined;
  /** Caller's abort signal state — aborted dispatches never retry. */
  aborted: boolean;
}

export type DispatchRetryDecision =
  | { kind: 'overloaded-wait'; delayMs: number }
  | { kind: 'overflow-fallback'; fallbackModel: string }
  | { kind: 'rethrow' };

/**
 * Classify a one-shot dispatch failure and decide the recovery action.
 * Pure — the caller owns counters, lease lifecycle, sleeping and logging.
 *
 *   - context overflow (thrown or content-shaped→rethrown) → one retry on the
 *     1M fallback compact model, unless the failing model already served a
 *     1M window (genuinely too much input — no cure) or the fallback is
 *     unusable.
 *   - overloaded/529 → up to {@link DISPATCH_OVERLOADED_MAX_RETRIES} retries,
 *     each after {@link DISPATCH_OVERLOADED_RETRY_DELAY_MS}.
 *   - anything else (incl. UsageLimitDispatchError, aborts) → rethrow.
 */
export function decideDispatchRetry(
  err: unknown,
  state: DispatchRetryState,
  opts?: { configuredFallbackModel?: string },
): DispatchRetryDecision {
  if (state.aborted) return { kind: 'rethrow' };

  // The usage-limit path has its own rotation loop + typed terminal error in
  // dispatchOneShot — never re-enter recovery for it (its capNotice could
  // theoretically mention "overloaded" in prose).
  if (err instanceof Error && err.name === 'UsageLimitDispatchError') return { kind: 'rethrow' };

  const message = String((err as { message?: unknown })?.message ?? '');
  const stderr = String((err as { stderrContent?: unknown })?.stderrContent ?? '');
  const combined = `${message} ${stderr}`;

  if (isContextOverflowErrorText(combined)) {
    if (state.overflowFallbackUsed) return { kind: 'rethrow' };
    const current = state.model ?? '';
    // A model that already serves 1M gains nothing from the fallback —
    // overflowing 1M means genuinely too much input, not a window mismatch
    // (same gate as applyAutoFallbackCompact).
    if (current && (hasOneMSuffix(current) || resolveContextWindow(current) >= 1_000_000)) {
      return { kind: 'rethrow' };
    }
    const fallbackModel = coerceToAvailableModel(
      opts?.configuredFallbackModel ?? config.claude.autoFallbackCompactModel,
    );
    if (!fallbackModel || fallbackModel === current || resolveContextWindow(fallbackModel) < 1_000_000) {
      return { kind: 'rethrow' };
    }
    return { kind: 'overflow-fallback', fallbackModel };
  }

  if (isOverloadedErrorText(combined)) {
    if (state.overloadedRetries >= DISPATCH_OVERLOADED_MAX_RETRIES) return { kind: 'rethrow' };
    return { kind: 'overloaded-wait', delayMs: DISPATCH_OVERLOADED_RETRY_DELAY_MS };
  }

  return { kind: 'rethrow' };
}

/**
 * Sleep that resolves early when `signal` aborts, so a goal-eval timeout (its
 * AbortController fires at 120s) is never held hostage by a 30s backoff.
 * Callers must re-check `signal.aborted` after awaiting.
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // Never keep the process alive just for a retry backoff.
    if (typeof timer.unref === 'function') timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
