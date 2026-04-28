/**
 * Dangerous Command Filter — parent-process surface.
 *
 * The full rule catalog (`DANGEROUS_RULES`) and the matcher helpers
 * (`matchRules`, `rulesByIds`, `overridableMatchedRuleIds`,
 * `overridableRulesByIds`, `isCrossUserAccess`, `isSshCommand`) live in
 * `somalib/permission/dangerous-rules.ts` so the permission MCP child can
 * import them without duplicating the catalog. This file re-exports them so
 * existing parent-process callers (`src/claude-handler.ts`, tests) keep
 * working unchanged.
 *
 * Parent-only logic that stays here:
 *   - `bypassBashPermissionDecision` — the bypass-mode Bash escalation.
 *     Lives outside somalib because it consults `SessionRegistry`-style
 *     `isRuleDisabled` predicates that are parent-side concepts.
 *   - `checkDangerousCommand` / `isDangerousCommand` — legacy helpers used
 *     by parent-process audit / logging.
 *   - `getOverridableRule` — convenience lookup for parent-side payload
 *     handlers; returns undefined for lockdown ids by design.
 *
 * See `somalib/permission/dangerous-rules.ts` for the file-header notes on
 * lockdown isolation invariants and the architecture of the rule catalog.
 */

import type { DangerousRule } from 'somalib/permission/dangerous-rules';
import { DANGEROUS_RULES, overridableRulesByIds } from 'somalib/permission/dangerous-rules';

export type { DangerousRule, DangerousRuleContext } from 'somalib/permission/dangerous-rules';
export {
  DANGEROUS_RULES,
  isCrossUserAccess,
  isSshCommand,
  matchRules,
  overridableMatchedRuleIds,
  overridableRulesByIds,
  rulesByIds,
} from 'somalib/permission/dangerous-rules';

/**
 * Legacy result type — preserved for backward compat with pre-catalog callers/tests.
 * `matchedRuleIds` is the new authoritative field; `matchedPatterns` is the
 * legacy label list kept for existing assertions.
 */
export interface DangerousCommandResult {
  readonly isDangerous: boolean;
  readonly matchedPatterns: ReadonlyArray<string>;
  readonly matchedRuleIds: ReadonlyArray<string>;
}

/**
 * Check if a bash command matches any dangerous pattern.
 * Returns labels (legacy) + rule ids.
 *
 * Note: legacy callers only looked at pattern-based rules. To avoid a behaviour
 * change, this function (like `isDangerousCommand`) considers ONLY
 * `sessionOverridable=true` rules — i.e. the classic DANGEROUS_PATTERNS set.
 * Lockdown rules are checked on their own enforcement paths.
 */
export function checkDangerousCommand(command: string): DangerousCommandResult {
  const matches = DANGEROUS_RULES.filter((rule) => rule.sessionOverridable && rule.match(command, {}));
  return {
    isDangerous: matches.length > 0,
    matchedPatterns: matches.map((r) => legacyDescriptionFor(r.id)),
    matchedRuleIds: matches.map((r) => r.id),
  };
}

/**
 * Simple boolean check for dangerous commands. Legacy-compatible scope:
 * only considers overridable (pattern-based) rules — NOT cross-user/ssh.
 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_RULES.some((rule) => rule.sessionOverridable && rule.match(command, {}));
}

/**
 * Result of the bypass-mode Bash permission decision.
 *
 * `decision`: hook return value — 'allow' skips the Slack prompt, 'ask' escalates
 * to the permission MCP tool which renders the Slack permission UI.
 * `matchedRuleIds`: overridable rules that are currently *active* (not session-disabled).
 * Empty when decision is 'allow'. Passed end-to-end to the Slack UI so the
 * "Approve & disable rule for this session" button knows what to disable.
 */
export interface BypassBashPermissionResult {
  readonly decision: 'allow' | 'ask';
  readonly matchedRuleIds: ReadonlyArray<string>;
}

/**
 * Bypass mode permission decision for Bash commands.
 *
 * Returns 'allow' for non-dangerous commands, 'ask' for dangerous ones
 * (subject to the session-scoped disable set).
 *
 * CRITICAL: This returns explicit decisions ('allow'/'ask') instead of deferring.
 * When permissionPromptToolName is set (always in Slack context), a deferred
 * decision causes the SDK to route through the permission MCP tool, triggering
 * Slack permission prompts even in bypass mode. Explicit decisions prevent this.
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
  if (matches.length === 0) {
    return { decision: 'allow', matchedRuleIds: [] };
  }
  const effective = matches.filter((rule) => !isRuleDisabled(rule.id));
  if (effective.length === 0) {
    return { decision: 'allow', matchedRuleIds: [] };
  }
  return { decision: 'ask', matchedRuleIds: effective.map((rule) => rule.id) };
}

/**
 * Look up an overridable rule by id. Returns undefined for unknown or
 * lockdown-only rule ids. Callers must tolerate undefined — stale button
 * payloads (e.g. old pending approvals after a rule rename) reach here.
 *
 * Delegates to `overridableRulesByIds` so the "drop lockdown ids" rule lives
 * in exactly one place — adding a new lockdown rule to the catalog
 * automatically excludes it here too.
 */
export function getOverridableRule(ruleId: string): DangerousRule | undefined {
  return overridableRulesByIds([ruleId])[0];
}

/**
 * Legacy description strings — kept stable so downstream log parsers or
 * existing test assertions (`matchedPatterns`) do not need to change.
 * New code should prefer `label` / `description` on the rule object.
 */
function legacyDescriptionFor(ruleId: string): string {
  switch (ruleId) {
    case 'kill':
      return 'kill process';
    case 'pkill':
      return 'pkill process';
    case 'killall':
      return 'killall process';
    case 'rm-recursive':
      return 'recursive delete';
    case 'rm-force':
      return 'force delete';
    case 'rm-force-long':
      return 'force delete (--force)';
    case 'shutdown':
      return 'system shutdown';
    case 'reboot':
      return 'system reboot';
    case 'halt':
      return 'system halt';
    case 'mkfs':
      return 'format filesystem';
    case 'dd-if':
      return 'disk copy (dd)';
    case 'chmod-world-recursive':
      return 'recursive world-writable chmod';
    default:
      return ruleId;
  }
}
