/**
 * Native non-Bash tools that run without a Slack permission prompt when the
 * user is in bypass (or auto) mode.
 *
 * In Slack context, `mcp-config-builder` always installs
 * `permissionPromptToolName`. Without an explicit allow, the SDK routes every
 * tool call through that prompt tool — popping a Slack permission UI even when
 * the user has bypass enabled. Two consumers read this list:
 *
 * - `agent-runtime/policy/tool-policy.ts` (`evaluateToolPolicy`) returns
 *   `allow` for these tools outside legacy mode, and joins them into the
 *   `tool1|tool2|...` PreToolUse matcher (`TOOL_POLICY_MATCHERS`).
 * - `mcp-config-builder.ts` adds them to `allowedTools` when bypass is on.
 *
 * Deny decisions (sensitive-path, cross-user, ssh-ban, abort-guard, mcp-grant,
 * pr-issue) are evaluated first in the tool policy, so listing a tool here does
 * not weaken any block.
 */

/**
 * Native tools that need an explicit `'allow'` decision under bypass mode.
 *
 * - `Bash` is excluded: the tool policy runs it through dangerous-rule
 *   escalation (`'ask'` / `'classify'`). Adding Bash here would bypass that.
 * - `Skill`, `EnterPlanMode`, `ExitPlanMode` are excluded: already listed in
 *   `allowedTools` (`mcp-config-builder.ts`), so the SDK never invokes the
 *   prompt tool for them.
 * - `AskUserQuestion`, `CronCreate`, `CronDelete`, `CronList` are excluded:
 *   they live in `disallowedTools` (`mcp-config-builder.ts`) so the SDK
 *   refuses them outright.
 *
 * The list is the complement of allowedTools ∪ disallowedTools against the
 * native tool surface emitted by SDK 0.2.111 (verified by grepping
 * `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` for tool name
 * literals). Adding/removing a tool requires deliberate review of this
 * comment and the lists it references.
 */
export const NATIVE_BYPASS_TOOLS: ReadonlyArray<string> = [
  'Write',
  'Edit',
  'NotebookEdit',
  'TodoWrite',
  'Read',
  'Glob',
  'Grep',
  'Task',
  'Agent',
  'WebFetch',
  'WebSearch',
  'KillShell',
];
