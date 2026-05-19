# Packages SRP Refactor Execution Review

Date: 2026-05-19 (Asia/Seoul)
Branch: `packages-srp-refactor-implementation`

## Objective

Execute the stale `packages-srp-refactor` plan in small, verifiable steps while preserving major end-to-end behavior. The implementation prioritizes outer boundaries first:

1. Establish package-level contract tests before moving behavior.
2. Move deploy/MCP/process-shared/common/test-utils foundations.
3. Move Slack leaf UI/runtime modules into `@soma/slack`.
4. Move Slack outer routers and pipeline orchestrators into `@soma/slack`.
5. Keep legacy `src/` import paths alive through root shims.
6. Verify package boundaries, TypeScript, focused behavior tests, and broad suite behavior.

## Implemented Package Boundary

The current implementation adds `packages/` workspaces and moves the Slack-oriented implementation surface into `@soma/slack`, with root files acting as compatibility shims where existing application code still imports from `src/`.

Key outer modules moved:

- `ActionHandlers`: package-owned registration/orchestration, root provider shim.
- `CommandRouter`: package-owned command routing, root handler provider shim.
- `EventRouter`: package-owned Slack event routing, root provider shim.
- `SessionUiManager`: package-owned session UI manager, root shim.
- `SessionInitializer`: package-owned dispatch/onboarding/channel-routing orchestration, root provider shim.
- `StreamExecutor`: package-owned stream execution orchestration, root provider shim.

The package manifest now exports these paths, including:

- `@soma/slack/actions`
- `@soma/slack/commands/command-router`
- `@soma/slack/event-router`
- `@soma/slack/session-manager`
- `@soma/slack/pipeline/session-initializer`
- `@soma/slack/pipeline/stream-executor`

## Compatibility Strategy

Root `src/slack/**` files remain as stable import shims. Runtime-only dependencies that should not live inside `@soma/slack` are injected through explicit provider setters:

- `setActionHandlersProviders`
- `setCommandRouterProviders`
- `setEventRouterProviders`
- `setSessionInitializerProviders`
- `setStreamExecutorProviders`

This keeps package source free of direct imports from `src/` and `somalib/` while preserving current application wiring.

The `SessionInitializer` and `StreamExecutor` moves required special handling for phase gating. Root shims provide the existing `config.ui.fiveBlockPhase` / `getEffectiveFiveBlockPhase` behavior so package-local singleton instances do not drift from the root runtime configuration.

## Contract Tests

The primary package boundary guard is:

- `src/__tests__/packages-srp-phase2-slack-contract.test.ts`

It verifies:

- `@soma/slack` manifest exports for moved modules.
- package source files exist for moved modules.
- legacy root shims still exist.
- root shims export from `@soma/slack/*`.
- root shims no longer contain the implementation classes/functions guarded by the test.
- package source does not import directly from root `src/` or `somalib/`.

Additional phase contract tests from earlier phases cover deploy/MCP/process-shared/common/test-utils boundaries.

## Verification Evidence

Fresh verification from this branch:

- `npm run build -w @soma/slack`: passed.
- `npm run build:somalib`: passed.
- `npm run build:packages`: passed.
- `npx tsc --noEmit --pretty false`: passed.
- `rg -n "from ['\"](\\.\\.\\/\\.\\.\\/src\\/|src\\/|somalib\\/)" packages/slack/src -g '*.ts'`: no matches.
- `git diff --check`: passed.
- Focused package/Slack pipeline tests: 257 passed.
- Full `npx vitest run`: 6454 passed, 10 failed.

Known full-suite failures are environment-dependent and not new package-boundary failures:

- `src/__tests__/claude-handler.integration.test.ts`: 5 failures because no healthy CCT slot is available.
- `src/notification-channels/__tests__/webhook-channel.test.ts`: 5 failures because `example.com` DNS validation is blocked before mock fetch is called.

`npm run build` still fails before compilation at `biome check src/ somalib/ scripts/` because of existing lint diagnostics unrelated to this refactor, including Node builtin import protocol and `noExplicitAny` warnings in existing tests.

## Current Risks

1. The implementation deliberately keeps many root shims to preserve compatibility. This is a migration stage, not final root removal.
2. `StreamExecutor` remains large inside `@soma/slack`; the SRP boundary is now package-level, but internal decomposition remains future work.
3. Provider wiring is powerful but must stay disciplined. New package code should avoid directly importing root runtime modules.
4. Full build is still blocked by pre-existing Biome diagnostics, so package/TypeScript verification is stronger evidence for this refactor than `npm run build`.

## Completion Checklist

- [x] Contract test exists before package-boundary moves.
- [x] Outer Slack action/command/event/session/pipeline modules moved into `@soma/slack`.
- [x] Legacy root imports remain usable through shims.
- [x] `@soma/slack` package exports moved modules.
- [x] Package source boundary scan rejects root/somalib imports.
- [x] Focused behavior tests cover `SessionInitializer` and `StreamExecutor`.
- [x] TypeScript compile passes.
- [x] Full test suite run recorded with known environment failures.
- [ ] External Claude review score >= 98/100.

## Active Goal Audit

Objective currently being pursued:

> `claude -p`로 Claude에게 전체 리뷰를 반복 요청하고, 리뷰 점수가 98점 이상이 될 때까지 구체 findings를 수정한다. 리뷰 요청에는 리팩토링 문서를 함께 전달한다.

Prompt-to-artifact checklist:

| Requirement | Evidence | Status |
|---|---|---|
| Refactoring document exists and is reviewable | `docs/current/plans/packages-srp-refactor/refactor-review.md` | Complete |
| Review prompt includes the refactoring document | `docs/current/plans/packages-srp-refactor/claude-review-prompt.md` lists `refactor-review.md` as the primary review document | Complete |
| Review prompt asks for a numeric score | `claude-review-prompt.md` output format begins with `Score: <0-100>` | Complete |
| Review prompt asks for blocking/important/minor findings | `claude-review-prompt.md` output format has those sections | Complete |
| Review prompt defines the 98+ threshold | `claude-review-prompt.md` scoring rule says 98+ only when no blocking/important findings remain | Complete |
| `claude -p` was attempted | Review log attempt 1 records the exact command and `ConnectionRefused` result | Complete |
| `claude -p` successfully produced a review | No Claude review output exists yet | Missing |
| Review score reached at least 98/100 | No score exists yet | Missing |
| Findings were iterated until threshold | No review findings exist yet | Missing |
| External context transfer approved | Escalated attempt was blocked because explicit approval to send repo context to external Claude API was absent | Missing |

Completion decision:

- Not complete.
- The next required step is explicit user approval for `claude -p` to transmit the refactor document and relevant repository context to Claude API.
- After approval, rerun the review command and update this log with score/findings. If score is below 98, fix concrete blocking/important findings and rerun review.

## Claude Review Log

Attempt 1:

- Command: `claude -p "$(cat docs/current/plans/packages-srp-refactor/claude-review-prompt.md)"`
- Result: failed with `API Error: Unable to connect to API (ConnectionRefused)`.

Attempt 2:

- Command: same `claude -p` review request with network escalation.
- Result: blocked by approval policy because the review can transmit private repository context to an external Claude API service.

Status:

- External Claude review is blocked until the user explicitly approves sending the refactor document and relevant repository context to Claude via `claude -p`.
- Review iteration to a score of 98/100 is therefore not complete yet.
