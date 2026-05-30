/**
 * Unified tool-call policy (ADR 0002 pass 2, epic #1023 P5).
 *
 * `ClaudeHandler.streamQuery` historically expressed its tool guards as a stack
 * of per-matcher `PreToolUse` hooks whose decisions the SDK merged with
 * `deny > allow` precedence. That works for the SDK backend but is unusable for
 * ACP (Track B P9), where soma's permission handler receives a *single*
 * permission request and must answer with one outcome.
 *
 * This module collapses those guards into one pure decision function,
 * `evaluateToolPolicy`, that both backends call:
 *   • SDK mode (P5, here): the streaming options builder registers a thin hook
 *     that resolves live state, calls `evaluateToolPolicy`, and maps the result
 *     to a `permissionDecision`. **No behavior change** — the precedence below
 *     reproduces the old multi-hook merge exactly.
 *   • ACP mode (P9, later): the ACP `requestPermission` handler calls the same
 *     function and maps the decision onto an ACP `PermissionOption`.
 *
 * Precedence (highest wins): **deny > ask > allow > pass**. `pass` means "no
 * policy opinion" — in SDK mode it maps to `{ continue: true }` (defer to the
 * SDK's own permission logic), NOT to `ask`; conflating the two would force a
 * Slack permission prompt where today the SDK silently proceeds.
 *
 * SDK-agnostic: this file imports only the pure guard primitives (no SDK type).
 */

import { bypassBashPermissionDecision, isCrossUserAccess, isSshCommand } from '../../dangerous-command-filter';
import { NATIVE_BYPASS_TOOLS } from '../../hooks/bypass-permission-guard';
import { handlePrIssuePrecondition } from '../../hooks/pr-issue-guard';
import {
  checkBashSensitivePaths,
  checkSensitiveGlob,
  checkSensitivePath,
  type SensitivePathResult,
} from '../../sensitive-path-filter';
import type { HandoffContext } from '../../types';

const PR_CREATE_MCP_TOOL = 'mcp__github__create_pull_request';

export type ToolPolicyDecision = 'allow' | 'deny' | 'ask' | 'pass';

export interface ToolPolicyResult {
  decision: ToolPolicyDecision;
  /** Human-readable reason, prefixed with the guard that decided. For audit logs. */
  reason: string;
  /**
   * Only set for the PR-issue deny — the SDK surfaces this to the model via
   * `permissionDecisionReason`. Other denies intentionally carry no surfaced
   * message (parity with the prior hooks, which only the PR-issue guard set).
   */
  denyMessage?: string;
}

/**
 * The resolved facts `evaluateToolPolicy` needs. Mutable/live state (abort
 * signal, handoff context) is resolved by the *caller* at hook-fire time and
 * passed in, keeping this function pure and deterministically testable.
 */
export interface ToolPolicyContext {
  /** Slack user id of the session owner/initiator. */
  user: string;
  /** `isAdminUser(user)` — admins bypass the ssh / sensitive / mcp guards. */
  isAdmin: boolean;
  /** Whether the session is in bypass-permissions mode (`mcpConfig.userBypass`). */
  userBypass: boolean;
  /** Live abort state at fire time (`abortController?.signal.aborted ?? false`). */
  aborted: boolean;
  /** Session-scoped dangerous-rule disable lookup (`sessionRegistry`). */
  isDangerousRuleDisabled: (ruleId: string) => boolean;
  /** Live handoff context; `undefined` → the PR-issue precondition is inactive. */
  handoffContext?: HandoffContext;
  /** Returns a deny reason for a permission-gated MCP tool, else null. */
  checkMcpToolPermission: (toolName: string) => string | null;
}

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Sensitive-path check dispatch — mirrors the per-matcher sensitive hooks
 * (`build-stream-options.ts`): Bash→command, Read→file_path, Glob→pattern+path,
 * Grep→path (only when present).
 */
function checkSensitiveForTool(toolName: string, input: Record<string, unknown>): SensitivePathResult | undefined {
  switch (toolName) {
    case 'Bash':
      return checkBashSensitivePaths(asStr(input.command));
    case 'Read':
      return checkSensitivePath(asStr(input.file_path));
    case 'Glob':
      return checkSensitiveGlob(asStr(input.pattern), typeof input.path === 'string' ? input.path : undefined);
    case 'Grep':
      return typeof input.path === 'string' && input.path ? checkSensitivePath(input.path) : { isSensitive: false };
    default:
      return undefined;
  }
}

/**
 * Evaluate the policy for a single tool call. Pure — same inputs always yield
 * the same decision. Precedence: deny > ask > allow > pass.
 */
export function evaluateToolPolicy(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  ctx: ToolPolicyContext,
): ToolPolicyResult {
  const input = toolInput ?? {};
  const command = asStr(input.command);

  // ── DENY tier (any one wins; order within the tier is immaterial) ──

  // 1. Abort guard (Bash only): deny all Bash after session abort to stop
  //    SDK fire-and-forget writes.
  if (toolName === 'Bash' && ctx.aborted) {
    return { decision: 'deny', reason: 'abort-guard: session aborted' };
  }

  // 2. SSH ban (Bash, non-admin).
  if (toolName === 'Bash' && !ctx.isAdmin && isSshCommand(command)) {
    return { decision: 'deny', reason: 'ssh-ban: ssh command for non-admin user' };
  }

  // 3. Sensitive-path (non-admin; Bash/Read/Glob/Grep).
  if (!ctx.isAdmin) {
    const sensitive = checkSensitiveForTool(toolName, input);
    if (sensitive?.isSensitive) {
      return { decision: 'deny', reason: `sensitive-path: ${sensitive.reason ?? 'sensitive location'}` };
    }
  }

  // 4. Cross-user directory isolation (Bash, always — even in bypass mode).
  if (toolName === 'Bash' && isCrossUserAccess(command, ctx.user)) {
    return { decision: 'deny', reason: 'cross-user: another user directory' };
  }

  // 5. MCP tool permission (mcp__ tools, non-admin) — catches mid-session grant
  //    expiry that the query-start allowedTools snapshot cannot.
  if (toolName.startsWith('mcp__') && !ctx.isAdmin) {
    const denied = ctx.checkMcpToolPermission(toolName);
    if (denied) {
      return { decision: 'deny', reason: `mcp-permission: ${denied}` };
    }
  }

  // 6. PR-issue precondition (#696) — handoff sessions must link a source issue
  //    before creating a PR. deny here wins over the bypass allow below (the
  //    prior code relied on SDK deny>allow merge; the ordering here encodes it).
  if (ctx.handoffContext && (toolName === 'Bash' || toolName === PR_CREATE_MCP_TOOL)) {
    const result = handlePrIssuePrecondition({ toolName, toolInput: input, handoffContext: ctx.handoffContext });
    if (result.blocked) {
      return {
        decision: 'deny',
        reason: `pr-issue: ${result.reason ?? 'precondition failed'}`,
        denyMessage: result.message,
      };
    }
  }

  // ── ASK / ALLOW tier (only reached when no deny fired) ──

  // 7. Bypass-mode Bash gate: explicit allow for non-dangerous, ask for
  //    dangerous (subject to session-scoped rule disable).
  if (toolName === 'Bash' && ctx.userBypass) {
    const { decision, matchedRuleIds } = bypassBashPermissionDecision(command, ctx.isDangerousRuleDisabled);
    if (decision === 'ask') {
      return { decision: 'ask', reason: `dangerous-bash: ${matchedRuleIds.join(',')}` };
    }
    return { decision: 'allow', reason: 'bypass-bash: non-dangerous' };
  }

  // 8. Native non-Bash bypass tools — explicit allow so the SDK does not route
  //    them through permissionPromptToolName and pop a Slack UI.
  if (ctx.userBypass && NATIVE_BYPASS_TOOLS.includes(toolName)) {
    return { decision: 'allow', reason: 'native-bypass: covered tool' };
  }

  // ── default: no policy opinion → defer ──
  return { decision: 'pass', reason: 'no policy opinion' };
}

/** The matchers a SDK PreToolUse hook must register to cover every governed tool. */
export const TOOL_POLICY_MATCHERS: readonly string[] = ['Bash', NATIVE_BYPASS_TOOLS.join('|'), 'mcp__'];
