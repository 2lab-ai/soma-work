/**
 * Dangerous Command Filter — parent-process surface.
 *
 * The full rule catalog (`DANGEROUS_RULES`) and the matcher helpers
 * (`matchRules`, `overridableMatchedRuleIds`,
 * `overridableRulesByIds`, `isCrossUserAccess`, `isSshCommand`) live in
 * `somalib/permission/dangerous-rules.ts` so the permission MCP child can
 * import them without duplicating the catalog. This file re-exports them; its
 * production importer is `src/agent-runtime/policy/tool-policy.ts`.
 *
 * Parent-only logic that stays here:
 *   - `bypassBashPermissionDecision` — the dangerous-rule check that
 *     `evaluateToolPolicy` runs on Bash commands in auto mode. Lives outside
 *     somalib because it consults `SessionRegistry`-style `isRuleDisabled`
 *     predicates that are parent-side concepts.
 *
 * See `somalib/permission/dangerous-rules.ts` for the file-header notes on
 * lockdown isolation invariants and the architecture of the rule catalog.
 */

import { DANGEROUS_RULES } from 'somalib/permission/dangerous-rules';

export type { DangerousRule, DangerousRuleContext } from 'somalib/permission/dangerous-rules';
export {
  DANGEROUS_RULES,
  isCrossUserAccess,
  isSshCommand,
  matchRules,
  overridableMatchedRuleIds,
  overridableRulesByIds,
} from 'somalib/permission/dangerous-rules';

/**
 * Result of `bypassBashPermissionDecision`.
 *
 * `decision`: 'allow' when no active dangerous rule matches, else 'ask'. In auto
 * mode `evaluateToolPolicy` turns 'ask' into `classify`, which hands the command
 * to the safety classifier.
 * `matchedRuleIds`: overridable rules that are currently *active* (not session-disabled).
 * Empty when decision is 'allow', non-empty when it is 'ask'. The safety classifier
 * receives them as context; the Slack permission prompt re-derives its own ids in
 * the permission MCP child.
 */
export interface BypassBashPermissionResult {
  readonly decision: 'allow' | 'ask';
  readonly matchedRuleIds: ReadonlyArray<string>;
}

/**
 * Dangerous-rule decision for a Bash command.
 *
 * Returns 'allow' for non-dangerous commands, 'ask' for dangerous ones
 * (subject to the session-scoped disable set).
 *
 * Despite the name, bypass mode does not call this: `evaluateToolPolicy`
 * allows every Bash command in bypass mode and calls this function only in auto
 * mode (`src/agent-runtime/policy/tool-policy.ts`).
 *
 * @param command  The bash command string.
 * @param isRuleDisabled
 *   Predicate that returns true for rule ids that should be treated as
 *   silenced for the current session. When all matched rules are disabled,
 *   the decision degrades to 'allow'. Defaults to always-false (no session).
 */
export function bypassBashPermissionDecision(
  command: string,
  isRuleDisabled: (ruleId: string) => boolean = () => false,
): BypassBashPermissionResult {
  // Only overridable rules participate in bypass escalation. Lockdown rules
  // (cross-user, ssh) have their own enforcement paths and must not be
  // silenced here even if a user previously approved them for the session.
  const matches = DANGEROUS_RULES.filter((rule) => rule.sessionOverridable && rule.match(command, {}));
  const matchedRuleIds = matches.map((rule) => rule.id).filter((ruleId) => !isRuleDisabled(ruleId));
  return { decision: matchedRuleIds.length === 0 ? 'allow' : 'ask', matchedRuleIds };
}
