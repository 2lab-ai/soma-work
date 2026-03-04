# Spec: Disallow Native Interactive Tools

## Problem

Claude Code SDK has built-in interactive tools (`AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`) that expect terminal input. soma-work runs in Slack context where terminal input is impossible.

### Symptoms

1. **AskUserQuestion called instead of model-command**: Claude calls native `AskUserQuestion` tool instead of `mcp__model-command__run` with `ASK_USER_QUESTION`. The native tool triggers a terminal prompt flow that doesn't work in Slack.
2. **Permission prompts triggered**: When Claude calls `AskUserQuestion` or `EnterPlanMode`, the SDK permission system asks via Slack UI for approval — confusing and pointless since these tools can't work anyway.
3. **Session destroyed**: After native `AskUserQuestion` is called, the session hangs waiting for terminal input or crashes, effectively destroying the active conversation.

## Solution

Use the SDK `disallowedTools` option to completely remove these tools from the model's context.

```typescript
// sdk.d.ts line 577-581
disallowedTools?: string[];
// "List of tool names that are disallowed. These tools will be removed
//  from the model's context and cannot be used, even if they would
//  otherwise be allowed."
```

### Tools to Disallow (Slack context only)

| Tool | Why Disallow |
|------|-------------|
| `AskUserQuestion` | Uses terminal prompt; soma-work has `ASK_USER_QUESTION` model-command instead |
| `EnterPlanMode` | Requires terminal approval flow; not supported in Slack |
| `ExitPlanMode` | Part of plan mode; not supported in Slack |

### Scope

- Only apply `disallowedTools` when `slackContext` is provided
- Non-Slack (CLI) usage should retain all native tools
- `dispatchOneShot` already sets `tools: []` — no change needed

## Architecture Decision

**Where to add**: `McpConfigBuilder.buildConfig()` — it already owns tool configuration.

- Add `disallowedTools` field to `McpConfig` interface
- Populate in `buildConfig()` when `slackContext` is present
- Apply in `ClaudeHandler.streamQuery()` alongside existing `allowedTools`

## Sizing

**small** (~20 lines) — 3 files, straightforward additions:
1. `mcp-config-builder.ts`: Add `disallowedTools` to interface + `buildConfig()`
2. `claude-handler.ts`: Apply `disallowedTools` to SDK options
3. Tests for both changes
