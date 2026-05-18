# Dispatch/Claude Unified Execution Refactor Plan

## Version
- Document Version: 1.0
- Date: 2026-01-23
- Scope: `src/dispatch-service.ts`, `src/claude-handler.ts`, `src/slack/pipeline/session-initializer.ts`

## 1. Summary
Dispatch is not a separate product path. It is just a first-turn classification. Today it uses a different client (`@anthropic-ai/sdk`) and different auth (API key), which is wrong. This plan unifies *all* Claude calls behind a single execution pipeline in `ClaudeHandler` and makes dispatch a one-shot mode of that pipeline.

## 2. Problem Statement
- Dispatch has its own client + auth rules.
- ClaudeHandler uses the Agent SDK + local subscription credentials.
- Result: dispatch fails when `ANTHROPIC_API_KEY` is absent even though the main bot works.

This is architectural duplication with different behavior paths. It should not exist.

## 3. Goals
- Single Claude execution path (Claude Agent SDK only).
- Dispatch is a first-turn, one-shot classification mode using the same auth and runtime as ClaudeHandler.
- No API key checks or Anthropic SDK usage in dispatch.
- Keep dispatch prompt and JSON parsing behavior unchanged.

## 4. Non-Goals
- Changing workflow classification rules or prompt text.
- Changing Slack pipeline behaviors unrelated to dispatch.
- Changing session state machine semantics.

## 5. Current Architecture (Problematic)
```
Slack SessionInitializer
  -> DispatchService (Anthropic API key path)
  -> ClaudeHandler (Agent SDK + subscription auth)
```
Two separate Claude call stacks. Two auth regimes. This is the bug.

## 6. Target Architecture (Unified)
```
Slack SessionInitializer
  -> ClaudeHandler (Agent SDK + subscription auth)
       -> dispatchOneShot(...)   // first-turn classification
       -> streamQuery(...)       // normal conversation
```
Single runtime. Single auth. Dispatch is just a mode.

## 7. Design Principles
- One Claude runtime, multiple call modes.
- Dispatch must never create or resume a session.
- Dispatch must not allow tool use or MCP servers.
- Failure in dispatch should gracefully fall back to default workflow, as today.

## 8. Proposed Changes

### 8.1 Introduce a Claude execution core (inside ClaudeHandler)
Create a small internal helper that owns:
- credential validation (`ensureValidCredentials`, `sendCredentialAlert`)
- SDK query options defaults (`settingSources`, `outputFormat`, etc.)
- abort handling

This helper is the only code that talks to `query()`.

### 8.2 Add a dispatch one-shot method to ClaudeHandler
Add something like:
```
class ClaudeHandler {
  async dispatchOneShot(
    userMessage: string,
    dispatchPrompt: string,
    model?: string,
    abortSignal?: AbortSignal
  ): Promise<string> { ... }
}
```
Behavior:
- Uses Agent SDK
- `systemPrompt: dispatchPrompt`
- `tools: []`
- `persistSession: false`
- `maxTurns: 1`
- `settingSources: ['user','project','local']`
- Does NOT resume or create session IDs
- Returns final assistant text for JSON parse

### 8.3 DispatchService becomes a thin adapter (or removed)
Option A (preferred): delete `DispatchService` and call `ClaudeHandler.dispatchOneShot` directly from `SessionInitializer`.
Option B: keep `DispatchService` but it only delegates to ClaudeHandler and contains JSON parsing logic.

### 8.4 Remove Anthropic API SDK usage
- Remove `@anthropic-ai/sdk` from dispatch
- Remove `ANTHROPIC_API_KEY` checks from dispatch configuration
- Keep API key usage elsewhere only if required (currently it is not)

### 8.5 Abort bridging
Current dispatch uses `AbortSignal`, SDK expects `AbortController`. Create a local `AbortController` and forward cancellation:
- if incoming signal aborts, call `controller.abort()`

## 9. Migration Plan (Steps)
1) **Add dispatchOneShot to ClaudeHandler**
   - Reuse existing credential validation and logging
   - Ensure `persistSession: false` and `maxTurns: 1`

2) **Refactor SessionInitializer**
   - Replace `DispatchService.dispatch()` call with `claudeHandler.dispatchOneShot()`
   - Keep workflow transition and fallback logic unchanged

3) **Move JSON parsing**
   - Keep existing JSON parsing logic from `DispatchService`
   - Either move it into `ClaudeHandler` or keep a small `DispatchParser` utility

4) **Remove Anthropic SDK dependency**
   - Delete `@anthropic-ai/sdk` usage
   - Update config/logging to stop complaining about missing `ANTHROPIC_API_KEY`

5) **Cleanup**
   - Delete dead code paths or reduce to adapter layer only

## 10. Risks & Mitigations
- **Risk:** Dispatch accidentally creates sessions or tools are allowed
  - **Mitigation:** Explicit `persistSession: false`, `tools: []`, no MCP config
- **Risk:** Dispatch latency increases with SDK startup
  - **Mitigation:** Keep dispatch model small (`DISPATCH_MODEL`) and maxTurns=1
- **Risk:** Missing credentials causes new failure modes
  - **Mitigation:** Reuse ClaudeHandler’s alert path and fallback to default workflow

## 11. Verification Plan
- With no `ANTHROPIC_API_KEY`, dispatch still classifies (via subscription auth)
- With missing local credentials, dispatch falls back to default workflow and sends alert
- PR URL -> `pr-review`
- "fix" + PR URL -> `pr-fix-and-update`
- Jira URL -> correct workflow

## 12. Acceptance Criteria
- Dispatch and normal conversation share the exact same auth/runtime stack
- No dispatch code path attempts to use the Anthropic API key
- Dispatch remains first-turn only, no session persistence
- Log output shows no config error about missing `ANTHROPIC_API_KEY`

