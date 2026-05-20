import type { AskUserQuestionParams, ModelCommandError, ModelCommandRunRequest } from './types';
type ValidationResult =
  | {
      ok: true;
      request: ModelCommandRunRequest;
    }
  | {
      ok: false;
      error: ModelCommandError;
    };
export declare function validateModelCommandRunArgs(args: unknown): ValidationResult;
/**
 * Soft quality rules for ASK_USER_QUESTION payloads.
 *
 * These run AFTER schema validation (`parseAskUserQuestionParams`) and never
 * reject a request — they only advise. The returned array carries warning
 * strings for any failing rule; an empty array means the question is
 * high-quality.
 *
 * Six rules (per Epic #544 Defect B spec):
 *   1. options count must be 2..4
 *   2. question must start with a tier prefix [tiny|small|medium|large|xlarge]
 *   3. context must be present and ≥ 80 chars (trimmed)
 *   4. option labels must not be forbidden meta/approval verbs
 *   5. exactly one option must carry the Recommended marker (label only)
 *   6. question field must be non-empty (not whitespace-only)
 */
export declare function checkAskUserQuestionQuality(params: AskUserQuestionParams): string[];
/**
 * Trailing "(Recommended)" or "(Recommended · N/M)" suffix — match-at-end-of-label only.
 *
 * Exported for reuse by Slack + dashboard legacy-fallback paths so all call sites agree on
 * what counts as a "legacy Recommended marker". Tighter than `/\(Recommended\b/i` — must anchor
 * at end-of-string (trailing whitespace allowed) so mid-label uses like
 * `"Option A (Recommended for staging only)"` do NOT match.
 */
export declare const LEGACY_RECOMMENDED_SUFFIX_RE: RegExp;
//# sourceMappingURL=validator.d.ts.map
