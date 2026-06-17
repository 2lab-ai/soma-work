/**
 * Production wiring for the auto-mode safety classifier (#auto-permission-mode).
 *
 * Architecture note: the parent process never imports an LLM backend in-process
 * (the SRP contract keeps LLM runtimes as subprocesses — see
 * `packages-srp-*-contract.test.ts`). So the production classifier shells out to
 * the `gemini` CLI for a single headless completion, mirroring how every other
 * LLM call in this codebase is a spawned child. The call is cheap-to-reason-
 * about, stateless, and only ever runs on a dangerous-rule hit (rare), so a cold
 * CLI start per call is acceptable.
 *
 * Everything fails CLOSED to `ask`:
 *   • classifier disabled via env  → `StaticSafetyClassifier` (always ask).
 *   • `gemini` missing / errors / times out → `LlmSafetyClassifier` catches and
 *     returns `ask`.
 *
 * Ops switches:
 *   • `PERMISSION_AUTO_CLASSIFIER=off`            — force the static (always-ask) path.
 *   • `PERMISSION_AUTO_CLASSIFIER_MODEL=<id>`     — override the model (default flash).
 *   • `PERMISSION_AUTO_CLASSIFIER_TIMEOUT_MS=<n>` — override the per-call timeout.
 */

import { execFile } from 'node:child_process';
import {
  LlmSafetyClassifier,
  type SafetyChatFn,
  type SafetyClassifier,
  StaticSafetyClassifier,
} from './safety-classifier';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 1 << 20; // 1 MiB of CLI output is plenty for a JSON verdict.

/**
 * A `SafetyChatFn` that runs one headless `gemini -p` completion and returns its
 * stdout. Rejects on non-zero exit / spawn error / timeout so the classifier
 * fails closed. When `model` is undefined the CLI's own default model is used
 * (omitting `-m` avoids depending on a specific model id being valid).
 */
export function createGeminiCliChatFn(model?: string): SafetyChatFn {
  return (prompt, { timeoutMs }) =>
    new Promise<string>((resolve, reject) => {
      const args = model ? ['-m', model, '-p', prompt] : ['-p', prompt];
      const child = execFile('gemini', args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `gemini classifier CLI failed: ${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ''}`,
            ),
          );
          return;
        }
        resolve(String(stdout ?? ''));
      });
      child.on('error', reject);
    });
}

/** Env-driven environment shape, injected for testability. */
export type SafetyClassifierEnv = Record<string, string | undefined>;

/**
 * Pure builder: resolves the configured classifier from an env snapshot.
 * Exported for unit testing (no singleton, no real spawn until `classify`).
 */
export function buildSafetyClassifier(env: SafetyClassifierEnv = process.env): SafetyClassifier {
  if ((env.PERMISSION_AUTO_CLASSIFIER ?? '').toLowerCase() === 'off') {
    return new StaticSafetyClassifier();
  }
  const model = env.PERMISSION_AUTO_CLASSIFIER_MODEL || undefined;
  const timeoutMs = Number(env.PERMISSION_AUTO_CLASSIFIER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  return new LlmSafetyClassifier(createGeminiCliChatFn(model), { timeoutMs });
}

let cached: SafetyClassifier | null = null;

/** Process-wide singleton classifier (lazy). */
export function getDefaultSafetyClassifier(): SafetyClassifier {
  if (!cached) cached = buildSafetyClassifier(process.env);
  return cached;
}

/** Test hook: reset the singleton. */
export function resetDefaultSafetyClassifierForTest(): void {
  cached = null;
}
