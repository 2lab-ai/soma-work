/**
 * Permission mode — single source of truth for the tri-state permission model
 * (#auto-permission-mode).
 *
 * Background: historically a single boolean `bypassPermission` drove two
 * behaviours — OFF → the SDK prompted the user for *every* tool call (manual
 * accept/reject), ON → a static dangerous-command catalog escalated risky Bash
 * to a Slack prompt while everything else ran. This collapses into a named
 * tri-state so the behaviour is explicit and selectable:
 *
 *   • `auto`  (DEFAULT) — the hard-deny tier still applies; non-dangerous Bash
 *     and native tools run; a *dangerous-rule hit* is handed to a safety
 *     classifier ("guardian" subagent, mirroring Codex `auto_review`) which
 *     either auto-approves or escalates to the human. Fail-closed to ask.
 *   • `bypass` (UNSAFE) — the hard-deny tier still applies (multi-tenant
 *     isolation: cross-user / ssh / sensitive-path / mcp-grant), but everything
 *     else runs with NO prompt — even a dangerous Bash. The deliberately unsafe
 *     choice.
 *   • `legacy` — the old "ask the user for every tool" flow (SDK
 *     `permissionMode:'default'`). Still honoured if explicitly set, but NOT
 *     offered as a user-selectable option any more.
 *
 * The hard-deny tier in `evaluateToolPolicy` is mode-independent and always
 * runs first; mode only governs the allow / ask / classify decision that
 * follows.
 */

export type PermissionMode = 'auto' | 'bypass' | 'legacy';

/** The default mode for any user without an explicit choice. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * Modes a user may pick in the `/z perm` (a.k.a. `/z bypass`) UI. `legacy` is
 * intentionally excluded — it is reachable only via an explicit stored value /
 * migration, never offered as a button.
 */
export const SELECTABLE_PERMISSION_MODES: readonly PermissionMode[] = ['auto', 'bypass'];

/** Type guard for the union — rejects stale / malformed stored values. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'auto' || value === 'bypass' || value === 'legacy';
}

/**
 * Stored permission fields, as they appear on a user-settings record. Both are
 * optional: `permissionMode` is the new authoritative field; `bypassPermission`
 * is the legacy boolean kept for backward-compatible migration.
 */
export interface StoredPermissionFields {
  permissionMode?: string;
  bypassPermission?: boolean;
}

/**
 * Resolve the effective mode from stored settings.
 *
 * Precedence:
 *   1. an explicit, valid `permissionMode` wins;
 *   2. else the legacy boolean: `bypassPermission === true` → `bypass`
 *      (preserve a user's prior explicit opt-in to running without prompts);
 *   3. else the new default, `auto`.
 *
 * A malformed `permissionMode` (e.g. an old `"on"` string) is ignored and the
 * resolver falls through to the legacy-boolean / default path.
 */
export function resolvePermissionMode(stored: StoredPermissionFields | undefined): PermissionMode {
  const explicit = stored?.permissionMode;
  if (isPermissionMode(explicit)) return explicit;
  if (stored?.bypassPermission === true) return 'bypass';
  return DEFAULT_PERMISSION_MODE;
}
