/**
 * Bypass-mode permission guard for native non-Bash tools.
 *
 * In Slack context, `mcp-config-builder` always installs
 * `permissionPromptToolName`. Without an explicit `permissionDecision: 'allow'`
 * from a PreToolUse hook, the SDK routes every tool call through that prompt
 * tool — popping a Slack permission UI even when the user has bypass enabled.
 * The existing bypass-Bash-gate hook in `claude-handler.ts` covers `Bash`
 * (with dangerous-rule escalation). This module covers the remaining native
 * tools so Write/Edit/Read/etc. do not pop a UI under bypass=ON.
 *
 * SDK matcher syntax: the hook matcher accepts a `tool1|tool2|...` alternation
 * string. The handshake in `@anthropic-ai/claude-agent-sdk@0.2.111`
 * (`cli.js: FeY`) splits on `|` and matches each token as a literal tool name,
 * so we collapse all covered tools into one HookCallbackMatcher entry.
 *
 * Callers MUST gate this on bypass=ON themselves (see `claude-handler.ts`
 * inside the existing `if (mcpConfig.userBypass)` block). This module never
 * decides whether bypass applies; it only encodes the per-tool decision when
 * it does.
 */

import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Matches the inline shape of `preToolUseHooks` in `claude-handler.ts` rather
 * than `HookCallbackMatcher` from the SDK — the SDK's `HookCallback` requires
 * `(input, toolUseId, signal)` arity but this codebase consistently registers
 * 1-arg hooks. Keeping the local shape avoids touching the other registration
 * sites just to add structural typing for this one entry.
 */
export interface PreToolUseHookEntry {
  matcher: string;
  hooks: Array<(input: HookInput) => Promise<HookJSONOutput>>;
}

/**
 * Native tools that need an explicit `'allow'` decision under bypass mode.
 *
 * - `Bash` is excluded: its existing `bypass-Bash-gate` hook in
 *   `claude-handler.ts` emits `'allow'` or `'ask'` based on dangerous-rule
 *   escalation. Adding Bash here would conflict with that escalation flow.
 * - `Skill`, `EnterPlanMode`, `ExitPlanMode` are excluded: already listed in
 *   `allowedTools` (`mcp-config-builder.ts`), so the SDK never invokes the
 *   prompt tool for them.
 * - `AskUserQuestion`, `CronCreate`, `CronDelete`, `CronList` are excluded:
 *   they live in `disallowedTools` (`mcp-config-builder.ts:282`) so the SDK
 *   refuses them outright.
 *
 * The list is the complement of allowedTools ∪ disallowedTools against the
 * native tool surface emitted by SDK 0.2.111 (verified by grepping
 * `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` for tool name
 * literals). Adding/removing a tool requires deliberate review of this
 * comment and the lists it references.
 */
const NATIVE_BYPASS_TOOLS: ReadonlyArray<string> = [
  'Write',
  'Edit',
  'NotebookEdit',
  'TodoWrite',
  'Read',
  'Glob',
  'Grep',
  'Task',
  'WebFetch',
  'WebSearch',
  'KillShell',
];

const BYPASS_ALLOW_MATCHER: string = NATIVE_BYPASS_TOOLS.join('|');

const allowDecision = async (): Promise<HookJSONOutput> => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
  },
});

/**
 * Build the single PreToolUse hook entry that explicitly approves the native
 * non-Bash tools listed in `NATIVE_BYPASS_TOOLS`.
 *
 * SDK merge semantics (verified against `@anthropic-ai/claude-agent-sdk@
 * 0.2.111`): `deny` from any matching hook wins over the `allow` this function
 * emits, so the existing sensitive-path / cross-user / ssh-ban / abort-guard
 * deny hooks continue to block what they used to block.
 */
export function buildBypassPermissionHookEntry(): PreToolUseHookEntry {
  return {
    matcher: BYPASS_ALLOW_MATCHER,
    hooks: [allowDecision],
  };
}

/**
 * Test-only: the exact matcher string the entry will register with the SDK.
 * Exposed for unit-test pinning of the covered tool set.
 */
export const BYPASS_ALLOW_MATCHER_FOR_TEST = BYPASS_ALLOW_MATCHER;

/**
 * Test-only: the read-only list of tool names covered by the entry.
 * Exposed so tests fail loudly when the audited set changes without an
 * accompanying comment update above.
 */
export const NATIVE_BYPASS_TOOLS_FOR_TEST: ReadonlyArray<string> = NATIVE_BYPASS_TOOLS;
