# ADR 0002: Agent Runtime Port — Pass 1

Status: Accepted
Date: 2026-05-26

## Context

`soma-work` currently uses `@anthropic-ai/claude-agent-sdk` (Claude Code
SDK) directly across many call sites. The longer-term goal is to be able
to swap the agent backend to ACP
([Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction))
so the bot is not tied to a single vendor's SDK. ACP standardizes
agent-editor communication over JSON-RPC and covers:

- session lifecycle (`initialize`, `session/new`, `session/load`,
  `session/prompt`, `session/cancel`),
- streaming updates (`session/update` for message chunks, tool calls,
  plans, mode changes),
- permission prompts (`session/request_permission`),
- file-system access (`fs/read_text_file`, `fs/write_text_file`),
- terminal control (`terminal/*`).

The migration is **not** a single change — it is several refactor
passes. Pass 1 establishes the dependency direction (where the SDK is
allowed to be imported) before any ACP code is written. Pass 2+ will
peel off the streaming conversation in `claude-handler.ts` and finally
introduce an ACP adapter behind the same port.

## Decision

### Pass 1 scope (this ADR)

Introduce `src/agent-runtime/`:

| File | Role |
|------|------|
| `agent-runner.ts` | Port: `AgentRunOptions` + `ClaudeCodeExtensionOptions`. No SDK imports. |
| `claude-code-runner.ts` | Adapter: the **only** runtime importer of `@anthropic-ai/claude-agent-sdk` for one-shot calls. Exports `runOneShotTextClaudeCode` + `toSdkOptions`. |
| `runner.ts` | Dispatcher: currently routes unconditionally to the Claude Code adapter. Pass-2+ adds a runtime selector. |
| `index.ts` | Public surface: `runOneShotText` + types. |

Migrate the **4 one-shot helpers** (5 `query()` loops total) to call
`runOneShotText` instead of `query()` directly:

- `src/conversation/summarizer.ts` (2 loops: `summarizeResponse`,
  `runTitleQuery`)
- `src/conversation/title-generator.ts`
- `src/conversation/instructions-summarizer.ts`
- `src/slack/z/topics/memory-improve.ts`

Boundary test (`src/agent-runtime/__tests__/boundary.test.ts`) asserts:

1. `runOneShotText` is exported from `src/agent-runtime`.
2. None of the 4 helpers import `@anthropic-ai/claude-agent-sdk` at
   runtime (pure `import type` is tolerated as a transitional concession).
3. The Claude Code adapter file does import the SDK (it *is* the
   adapter).

### Pass 1 non-goals (strictly out of scope)

The following stay untouched in pass 1 to keep the diff small and the
review surface tight:

- **`src/claude-handler.ts`** (1433 lines): the main streaming
  conversation facade. Tangled with credentials, hooks, MCP, and
  permission policy. Pass 2+.
- **`src/hooks/*` and `src/slack/hooks/*`**: PreCompact / PostCompact /
  SessionStart hook handlers. These are Claude-Code-specific extensions
  with no ACP equivalent — they will stay agent-side regardless of
  protocol. Documented as "extension surface" here; not moved.
- **Multi-slot OAuth credentials manager**, **bypass-permission guard**,
  **dangerous-command filter**, **sensitive-path filter**: our policy
  layer on top of the SDK's permission system. Stays as-is.
- **Plugin directory mounting** (`--plugin` style), **MCP config
  injection through `Options.mcp_servers`**: Claude Code packaging
  details, not protocol concerns.
- **Slack-specific persona / routing / directives**: never portable.

## ACP-Applicable vs Extension Surface

This is the inventory pass-2+ will use to decide what becomes a real
ACP method call versus what stays inside the adapter.

| Code path | Pass-2+ direction |
|-----------|-------------------|
| `query()` streaming in `claude-handler.ts` | Map to ACP `session/prompt` + `session/update`. |
| Permission prompt (`canUseTool`) | Map to ACP `session/request_permission`. |
| File-system tool implementations | Map to ACP `fs/read_text_file`, `fs/write_text_file`. |
| Terminal tool implementations | Map to ACP `terminal/*`. |
| Hooks (`PreCompact`, `PostCompact`, `SessionStart`, `PreToolUse`, …) | **Stay agent-side.** No ACP equivalent. Keep under `src/hooks/` and tag as extension. |
| Multi-slot OAuth credentials manager | **Stay agent-side.** The agent process owns auth. |
| Bypass-permission guard, dangerous-command filter, sensitive-path filter | **Stay agent-side.** Our policy on top of any SDK's permission flow. |
| Plugin directory mounting | **Stay agent-side.** Claude-Code packaging detail. |
| MCP server config injection | Adapter-side: ACP agents can also host MCP servers, but the config wiring is per-backend. |
| Adaptive-thinking display modes | **Stay agent-side.** UX layer, not protocol. |
| Slack persona / channel routing / directives | **Stay agent-side.** Never protocol. |

## Option Shape: Tiny Portable Core + Named Extension Bags

The portable core is intentionally minimal:

```ts
interface AgentRunOptions {
  model: string;
  maxTurns?: number;
  systemPrompt?: string;
  tools?: string[];
  extensions?: { claudeCode?: ClaudeCodeExtensionOptions };
}
```

Backend-specific knobs (Claude Code's `env`, `thinking`, `settingSources`,
`plugins`, `stderr`) live in a *named* bag so callers explicitly declare
their backend dependency. When an ACP adapter is added, it gets its own
`extensions.acp` bag — the port itself never grows backend fields.

Rejected alternatives:

- **Mirror SDK `Options` 1:1** — preserves the wrong dependency.
- **Define ACP-shaped options today** — ACP's option/prompt shape is
  prompt-turn-oriented, not equivalent to Claude SDK `Options`.
  Translating in pass 1 risks pinning down the wrong abstraction.

## Messages: Not Abstracted in Pass 1

`runOneShotText` returns `Promise<string>` — the accumulated assistant
text — because every one-shot helper does exactly that today. We do
**not** introduce an `AgentMessage` type in pass 1. When streaming moves
behind the port (pass 2+), the abstraction will be driven by Slack's
display needs, not by the SDK's `SDKMessage` shape.

## Consequences

- The 4 one-shot helpers no longer depend on
  `@anthropic-ai/claude-agent-sdk` at runtime.
- A boundary test pins this dependency direction. Any future helper
  that wires straight to the SDK fails the boundary test on PR CI.
- The dispatcher (`runner.ts`) is the single seam where a second
  backend (ACP) can be slotted in without touching helpers.
- `claude-handler.ts` is intentionally unchanged; its migration is
  pass 2+.

## Evidence

- Codex consult `7922780d-f680-40f2-b0c1-4771d107516e` aligned pass-1
  scope and rejected three over-broad alternatives (mirror Options,
  define AgentMessage now, move hooks now).
- Boundary test: `src/agent-runtime/__tests__/boundary.test.ts`.
- Mapper unit tests: `src/agent-runtime/__tests__/options-mapper.test.ts`.
- Runner adapter test: `src/agent-runtime/__tests__/runner.test.ts`.
- Regression coverage (pre-existing): the `#762` thinking-disabled
  guard in `src/conversation/__tests__/summarizer-thinking.test.ts`
  continues to pass through the migrated helpers — the SDK module mock
  still intercepts the `query()` call inside the adapter, and
  `toSdkOptions` preserves the `thinking` field verbatim.
