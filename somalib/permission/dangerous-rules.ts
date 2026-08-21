/**
 * Dangerous Command Rules — re-exported from the shared `soma-lib` package.
 *
 * The canonical catalog and matching engine moved to
 * https://github.com/2lab-ai/soma-lib (`src/domain/command-safety`) as Step 1
 * of the soma ⊕ soma-work convergence roadmap (soma-lib docs/ROADMAP.md).
 * This file stays as a thin re-export so every existing import path —
 * `somalib/permission/dangerous-rules` from `src/` and
 * `@soma/process-shared/permission/dangerous-rules` from the MCP children —
 * keeps working unchanged.
 *
 * Rule changes now happen in soma-lib (release a new tag, bump the tarball
 * dependency here). See soma-lib's file header for the catalog architecture
 * and the lockdown isolation invariant, which is still verified by this
 * repo's `src/__tests__/dangerous-command-filter.test.ts`.
 */
export type { DangerousRule, DangerousRuleContext, RuleSet } from 'soma-lib';
export {
  DANGEROUS_RULES,
  createRuleSet,
  isCrossUserAccess,
  isSshCommand,
  matchRules,
  overridableMatchedRuleIds,
  overridableRulesByIds,
  rulesByIds,
} from 'soma-lib';
