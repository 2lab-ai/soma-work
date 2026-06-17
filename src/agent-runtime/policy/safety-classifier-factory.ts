/**
 * Production wiring for the auto-mode safety classifier (#auto-permission-mode).
 *
 * The classifier reuses the EXISTING unified one-shot model path —
 * `ClaudeHandler.dispatchOneShot` — the very same flow that workflow-dispatch
 * and the executive summary use to start a throwaway Claude conversation
 * (unified lease auth, cheap dispatch model). It does NOT open any bespoke API
 * route. `claude-handler.ts` owns the `ClaudeHandler` instance and injects a
 * thin dispatch adapter here.
 *
 * Everything fails CLOSED to `ask`:
 *   • classifier disabled via env, or no dispatch wired → `StaticSafetyClassifier`.
 *   • dispatch throws / times out / returns unparseable output → `ask`.
 *
 * Ops switches:
 *   • `PERMISSION_AUTO_CLASSIFIER=off`            — force the static (always-ask) path.
 *   • `PERMISSION_AUTO_CLASSIFIER_MODEL=<id>`     — override the dispatch model.
 *   • `PERMISSION_AUTO_CLASSIFIER_TIMEOUT_MS=<n>` — override the per-call timeout.
 */

import {
  LlmSafetyClassifier,
  type SafetyChatFn,
  type SafetyClassifier,
  StaticSafetyClassifier,
} from './safety-classifier';

/**
 * Cheap, fast classification model — the same default workflow-dispatch uses
 * (`FALLBACK_DISPATCH_MODEL` in `dispatch-service.ts`). Overridable via env.
 */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 20_000;

/** System prompt for the dispatch one-shot — the guardian reviewer role. */
const SAFETY_SYSTEM_PROMPT = [
  'You are a SAFETY REVIEWER (guardian) for an autonomous coding agent.',
  'You receive one tool call that a static rule already flagged as potentially',
  'dangerous, and you decide whether it is safe to AUTO-APPROVE or whether a',
  'human should be asked first. Be conservative: when in doubt, ask.',
  'Reply with STRICT JSON only, no prose: {"verdict":"allow"|"ask","reason":"<= 20 words"}.',
].join(' ');

/**
 * Adapter over `ClaudeHandler.dispatchOneShot`. `userMessage` is the concrete
 * tool-call context (the classifier prompt); `systemPrompt` is the reviewer
 * role. Returns the model's raw text. Injected by `claude-handler.ts`.
 */
export type SafetyDispatchFn = (
  userMessage: string,
  systemPrompt: string,
  opts: { model?: string; abortController?: AbortController },
) => Promise<string>;

/** Env-driven environment shape, injected for testability. */
export type SafetyClassifierEnv = Record<string, string | undefined>;

export interface BuildSafetyClassifierArgs {
  env?: SafetyClassifierEnv;
  /** The dispatch adapter. When omitted, the classifier fails closed to ask. */
  dispatch?: SafetyDispatchFn;
}

/**
 * Build the classifier from an env snapshot + a dispatch adapter. Pure: no
 * model call happens until `classify`.
 */
export function buildSafetyClassifier(args: BuildSafetyClassifierArgs = {}): SafetyClassifier {
  const env = args.env ?? process.env;
  if (!args.dispatch || (env.PERMISSION_AUTO_CLASSIFIER ?? '').toLowerCase() === 'off') {
    return new StaticSafetyClassifier();
  }
  const dispatch = args.dispatch;
  const model = env.PERMISSION_AUTO_CLASSIFIER_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(env.PERMISSION_AUTO_CLASSIFIER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const chat: SafetyChatFn = (prompt) => dispatch(prompt, SAFETY_SYSTEM_PROMPT, { model });
  return new LlmSafetyClassifier(chat, { timeoutMs });
}
