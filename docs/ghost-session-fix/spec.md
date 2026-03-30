# Ghost Session Fix — Spec

> STV Spec | Created: 2026-03-27 | Issue: #99

## 1. Overview
`V1QueryAdapter.start()`/`continue()`가 매번 `new AbortController()`를 생성하여 `RequestCoordinator`에 등록된 컨트롤러를 덮어쓴다. abort 신호가 SDK 스트리밍에 도달하지 않아 고스트 세션이 발생한다.

## 2. User Stories
- As a user, I want `!{prompt}` to immediately stop the current stream and start a new one, so that I maintain control.
- As a user, I want `close` to completely terminate all streaming activity, so that ghost sessions don't persist.
- As a user, I want only one streaming process per thread at any time, so that I don't get duplicate responses.

## 3. Acceptance Criteria
- [ ] `requestCoordinator.abortSession()` aborts the same controller the SDK is using
- [ ] `!{prompt}` stops the running stream before starting a new one
- [ ] `close` terminates all streaming for the session
- [ ] `removeController` doesn't accidentally remove a newer request's controller
- [ ] Existing tests pass (no regression)

## 4. Scope
### In-Scope
- P0: AbortController unification in V1QueryAdapter
- P1: CAS-style removeController in RequestCoordinator
- P2: session.terminated flag for defense-in-depth

### Out-of-Scope
- Slack Bolt event serialization (separate concern)
- Auto-resume/retry refactor (doesn't cause ghost sessions)
- Multi-instance dedup (infrastructure-level concern)

## 5. Architecture

### 5.1 Fix Points
```
V1QueryAdapter.start()     → stop creating new AbortController, use baseParams one
V1QueryAdapter.continue()  → same
RequestCoordinator         → removeController(key, expected) CAS guard
SessionRegistry            → terminated flag on session object
StreamExecutor             → check terminated flag per event
```

### 5.2 Change Summary
| File | Change | Lines |
|------|--------|-------|
| `src/agent-session/v1-query-adapter.ts` | Remove `new AbortController()` in start()/continue() | ~4 |
| `src/slack/request-coordinator.ts` | Add CAS guard to removeController | ~8 |
| `src/session-registry.ts` | Add terminated flag to terminateSession | ~3 |
| `src/slack/pipeline/stream-executor.ts` | Check terminated in streaming callbacks | ~5 |
| Tests | Unit tests for each fix | ~40 |

### 5.3 Integration Points
- `SessionInitializer.handleConcurrency()` — creates and registers the AbortController
- `SlackHandler.handleMessage()` — abort path for `!` prefix
- `SessionActionHandler.handleCloseConfirm()` — close confirmation path

## 6. Non-Functional Requirements
- Performance: No impact (removing object creation, adding one Map lookup)
- Reliability: Strictly improves — abort now reaches SDK
- Backward Compatibility: No API changes, internal-only fix

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Reuse baseParams.abortController instead of new | tiny | Direct fix, 2 line delete |
| CAS guard on removeController | small | Prevents cross-request interference |
| terminated flag pattern | small | Defense-in-depth, standard pattern |
| No Slack Bolt serialization | out-of-scope | Different root cause, separate issue |

## 8. Open Questions
None.

## 9. Next Step
→ Proceed with Vertical Trace via `stv:trace`
