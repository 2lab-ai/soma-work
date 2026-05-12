/**
 * Bypass-mode permission guard for native non-Bash tools.
 *
 * Slack context always installs `permissionPromptToolName`. Without an explicit
 * `permissionDecision: 'allow'` from a PreToolUse hook, the SDK routes every
 * tool call through that prompt — popping a Slack permission UI even when the
 * user has bypass permission enabled. The existing bypass-Bash-gate hook in
 * `claude-handler.ts` covers `Bash`; this module covers the remaining native
 * tools so Write/Edit/etc. do not pop a UI under bypass=ON.
 *
 * SDK merge precedence is `deny > defer > ask > allow > undefined`
 * (confirmed against `@anthropic-ai/claude-agent-sdk@0.2.111` cli.js:8219).
 * Any stricter hook (sensitive-path deny, cross-user deny, abort deny) on the
 * same matcher therefore still wins; this module only flips the default
 * outcome from "SDK falls back to prompt" to "explicit allow".
 *
 * Why this is its own module: the bypass-Bash-gate hook depends on
 * SessionRegistry + dangerous-rule lookup; this guard is stateless. Keeping
 * them separate avoids dragging the registry into the test surface for native
 * tools that have no per-rule escalation semantics.
 */

import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Native non-Bash tools that need an explicit `'allow'` decision under bypass
 * mode. `Bash` is intentionally excluded — it has its own bypass-Bash-gate hook
 * in `claude-handler.ts` that emits `'allow'` or `'ask'` based on
 * `bypassBashPermissionDecision`. Tools auto-listed in `allowedTools`
 * (`Skill`, `EnterPlanMode`, `ExitPlanMode`) also do not need a hook.
 */
const NATIVE_BYPASS_MATCHERS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'Read',
  'Glob',
  'Grep',
] as const;

export type NativeBypassToolName = (typeof NATIVE_BYPASS_MATCHERS)[number];

export const NATIVE_BYPASS_TOOL_NAMES: ReadonlyArray<NativeBypassToolName> = NATIVE_BYPASS_MATCHERS;

export interface BypassPermissionGuardInput {
  /** Mirror of `mcpConfig.userBypass` resolved at query-build time. */
  userBypass: boolean;
}

export interface BypassPermissionHookEntry {
  matcher: string;
  hooks: Array<(input: HookInput) => Promise<HookJSONOutput>>;
}

/**
 * Build PreToolUse hook entries that explicitly approve native non-Bash tools
 * when the user has bypass permission enabled.
 *
 * Returns an empty array when `userBypass=false` — bypass-off users follow the
 * SDK's default permission flow through `permissionPromptToolName`, which is
 * the intended UX.
 */
export function buildBypassPermissionHookEntries(input: BypassPermissionGuardInput): BypassPermissionHookEntry[] {
  if (!input.userBypass) {
    return [];
  }
  return NATIVE_BYPASS_MATCHERS.map((matcher) => ({
    matcher,
    hooks: [
      async (): Promise<HookJSONOutput> => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      }),
    ],
  }));
}
