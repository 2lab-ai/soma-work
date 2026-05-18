# Dispatch must use ClaudeHandler auth only (Claude subscription, no separate API key)

## Summary
Dispatch currently hard-requires `ANTHROPIC_API_KEY` and falls back to the default workflow when running with Claude subscription (system auth). This breaks routing for users who authenticate via the Claude Code subscription. Dispatch must use the exact same authentication path as `ClaudeHandler` (Claude Agent SDK + local credentials). No separate authentication logic or API-key path is allowed.

## Current Behavior
- `DispatchService` uses `@anthropic-ai/sdk` and checks `ANTHROPIC_API_KEY` in `validateConfiguration()`.
- When the API key is missing, it logs a config error and immediately falls back to the default workflow.
- Example log:
  - `DISPATCH CONFIG ERROR: ANTHROPIC_API_KEY not set. Dispatch will fail.`
  - `No dispatch prompt, defaulting to default workflow`

## Root Cause
`src/dispatch-service.ts` hard-codes the Anthropic API client and marks dispatch as unconfigured if `ANTHROPIC_API_KEY` is unset. This ignores the existing Claude subscription authentication used by `ClaudeHandler` (`@anthropic-ai/claude-agent-sdk` + local credentials).

## Desired Behavior
- Dispatch must work with Claude subscription (system auth) without requiring `ANTHROPIC_API_KEY`.
- Dispatch must reuse the exact Claude SDK auth path already used by `ClaudeHandler` (no duplicated or separate auth logic).
- Keep current fallback behavior (default workflow) only for genuine failures (prompt missing, credential validation failure, model error, timeout), not for missing API key.
- Remove any concept of a separate Anthropic API path for dispatch.

## Proposed Implementation
### Provider selection
- None. Dispatch does not select providers. It always goes through ClaudeHandler auth.
- Remove all Anthropic API client usage and API-key checks in dispatch.

### SDK-based dispatch (system auth)
- Route dispatch through a helper on `ClaudeHandler` so it inherits the same credential validation and alerting. DispatchService must not do its own credential checks.
- Run a one-shot classification using `@anthropic-ai/claude-agent-sdk` with:
  - `systemPrompt: dispatchPrompt`
  - `tools: []` (no tool use)
  - `persistSession: false`
  - `maxTurns: 1`
  - `settingSources: ['user', 'project', 'local']` (match ClaudeHandler)
  - `model: DISPATCH_MODEL` if set; otherwise let Claude Code pick default.
- Parse the final assistant text using existing JSON extraction logic.

### Reuse ClaudeHandler (required)
- Add a helper method on `ClaudeHandler` to run a non-session, no-tool, one-shot query with a custom system prompt.
- `DispatchService` must call this helper to avoid duplicating SDK query configuration or auth handling.

### Abort/timeout behavior
- The SDK takes `abortController`, not `AbortSignal`.
- Bridge the current `AbortSignal` by creating a new `AbortController` and aborting it when the signal fires.

## Files to Touch
- `src/dispatch-service.ts` (remove Anthropic SDK usage; use ClaudeHandler helper)
- `src/claude-handler.ts` (required helper for one-shot dispatch query)
- `src/credentials-manager.ts` / `src/credential-alert.ts` (no new logic; reused implicitly via ClaudeHandler)
- `package.json` (remove `@anthropic-ai/sdk` if no longer used)

## Acceptance Criteria
- Dispatch succeeds with Claude subscription only (no `ANTHROPIC_API_KEY`).
- No config error about missing `ANTHROPIC_API_KEY` when using SDK provider.
- If credentials are missing/invalid, dispatch cleanly falls back to `default` and logs a clear error.
- No API-key path exists for dispatch.
- JSON parsing and fallback title behavior remain unchanged.

## Test Plan
- Unit test: provider selection when API key is missing uses SDK path.
- Unit test: missing credentials triggers fallback to `default` (and optional alert).
- Unit test: SDK response with JSON is parsed correctly.
- Manual: run bot with only Claude subscription auth and confirm workflow routing (e.g., PR URL -> `pr-review`).

## Notes
- This change removes a hard dependency on `ANTHROPIC_API_KEY` for dispatch, aligning behavior with the rest of the bot.
