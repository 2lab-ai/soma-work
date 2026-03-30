# Ghost Session Fix — Vertical Trace

> STV Trace | Created: 2026-03-27
> Spec: docs/ghost-session-fix/spec.md
> Issue: #99

## Table of Contents
1. [Scenario 1 — AbortController Unification (P0)](#scenario-1)
2. [Scenario 2 — CAS-style removeController (P1)](#scenario-2)
3. [Scenario 3 — session.terminated Flag (P2)](#scenario-3)

---

## Scenario 1 — AbortController Unification (P0)

### 1. Entry Point
- Event: Slack message → `handleMessage()` → pipeline
- Trigger: `!{prompt}` or `close` command

### 2. Input
- `sessionKey`: string (channel-threadTs)
- `abortController`: AbortController (created by SessionInitializer)

### 3. Layer Flow

#### 3a. SessionInitializer.handleConcurrency()
- `session-initializer.ts:884` → `new AbortController()` = controllerA
- `session-initializer.ts:885` → `requestCoordinator.setController(sessionKey, controllerA)`
- Returns: `controllerA`
- Transformation: SessionInitResult.abortController = controllerA

#### 3b. SlackHandler.createAgentSession()
- `slack-handler.ts:464` → `executeParams.abortController = sessionResult.abortController` (= controllerA)
- `slack-handler.ts:475` → `new V1QueryAdapter({ executeParams })`
- Transformation: executeParams.abortController = controllerA → V1QueryAdapter.baseParams.abortController

#### 3c. V1QueryAdapter (CURRENT — BROKEN)
- `v1-query-adapter.ts:50` → constructor: `this._abortController = executeParams.abortController` (= controllerA)
- `v1-query-adapter.ts:56` → start(): `this._abortController = new AbortController()` (= controllerB) ← **BUG**
- `v1-query-adapter.ts:65` → continue(): `this._abortController = new AbortController()` (= controllerC) ← **BUG**
- `v1-query-adapter.ts:157` → executeTurn(): `params.abortController = this._abortController` (= controllerB)
- Transformation: controllerA → **DISCARDED**, controllerB used by SDK

#### 3d. V1QueryAdapter (FIXED)
- `v1-query-adapter.ts:56` → start(): **DELETE** `this._abortController = new AbortController()`
- `v1-query-adapter.ts:65` → continue(): **DELETE** `this._abortController = new AbortController()`
- Result: `this._abortController` stays as controllerA from constructor
- Transformation: controllerA → passed to SDK → requestCoordinator.abort(controllerA) reaches SDK ✅

### 4. Side Effects
- Before fix: abort(controllerA) → controllerA dies, controllerB (SDK) lives → ghost
- After fix: abort(controllerA) → controllerA dies → SDK gets signal → stream stops ✅

### 5. Error Paths
| Condition | Before Fix | After Fix |
|-----------|-----------|-----------|
| `!{prompt}` sent | Old stream continues (ghost) | Old stream aborted, new starts |
| `close` sent | Stream continues after session deleted | Stream aborted before session deleted |

### 6. Output
- abort() → SDK streaming stops → no more Slack messages from ghost process

### 7. Observability
- Log: `RequestCoordinator.abortSession()` already logs abort
- Verify: after abort, `abortController.signal.aborted === true` on the SDK-used controller

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `start() should use baseParams abortController` | Contract | Scenario 1, Section 3c→3d |
| `continue() should use baseParams abortController` | Contract | Scenario 1, Section 3c→3d |
| `abort via requestCoordinator reaches SDK controller` | Happy Path | Scenario 1, Section 4 |
| `executeTurn passes same controller to executor` | Contract | Scenario 1, Section 3c |

---

## Scenario 2 — CAS-style removeController (P1)

### 1. Entry Point
- Event: `StreamExecutor.execute()` finally block
- File: `stream-executor.ts:741-743`

### 2. Input
- `sessionKey`: string
- `expectedController`: AbortController (the one this request registered)

### 3. Layer Flow

#### 3a. StreamExecutor.cleanup() (CURRENT — BROKEN)
- `stream-executor.ts:1062-1063` → `requestCoordinator.removeController(sessionKey)`
- Problem: removes by key only → older request can remove newer request's controller

#### 3b. RequestCoordinator.removeController() (FIXED)
- `request-coordinator.ts:33` → add `expectedController` parameter
- Only delete if `this.activeControllers.get(sessionKey) === expectedController`
- Transformation: unconditional delete → conditional CAS delete

#### 3c. StreamExecutor.cleanup() (FIXED)
- Pass the request's own abortController to removeController
- `requestCoordinator.removeController(sessionKey, abortController)`

### 4. Side Effects
- Before: older finally removes newer controller → newer becomes un-abortable
- After: older finally skips removal (CAS mismatch) → newer stays abortable ✅

### 5. Error Paths
| Condition | Before Fix | After Fix |
|-----------|-----------|-----------|
| Two concurrent requests, old finishes first | New request's controller removed | Old request's removal is no-op |

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `removeController with matching controller removes it` | Happy Path | Scenario 2, Section 3b |
| `removeController with mismatched controller is no-op` | Sad Path | Scenario 2, Section 3b |
| `cleanup passes own controller to removeController` | Contract | Scenario 2, Section 3c |

---

## Scenario 3 — session.terminated Flag (P2)

### 1. Entry Point
- Event: `terminateSession()` called
- File: `session-registry.ts:954-968`

### 2. Input
- `sessionKey`: string
- Session object reference held by in-flight StreamExecutor

### 3. Layer Flow

#### 3a. SessionRegistry.terminateSession() (FIXED)
- `session-registry.ts:955` → Before deleting from Map, set `session.terminated = true`
- In-flight code holding session reference sees the flag

#### 3b. ConversationSession type (FIXED)
- `types.ts` → Add `terminated?: boolean` field

#### 3c. StreamExecutor streaming callbacks (FIXED)
- `stream-executor.ts` → In `onToolUse`, `onToolResult`, check `session.terminated`
- If true, abort the controller and return early

### 4. Side Effects
- Before: terminateSession deletes from Map, but in-flight code keeps session reference and continues
- After: in-flight code sees `terminated = true` and self-terminates ✅

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `terminateSession sets terminated flag before delete` | Side-Effect | Scenario 3, Section 3a |
| `streaming callbacks check terminated flag` | Contract | Scenario 3, Section 3c |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Delete lines in V1QueryAdapter (not refactor) | tiny | 2 lines removed, no new logic |
| CAS guard uses reference equality (===) | tiny | AbortController is object, === is correct |
| terminated flag on session object (not separate Map) | small | In-flight code already holds session ref |
| Check terminated in onToolUse/onToolResult only | small | These are the main recurring callbacks |

## Implementation Status
| Scenario | Trace | Tests (RED) | Implementation | Status |
|----------|-------|-------------|----------------|--------|
| 1. AbortController Unification (P0) | done | GREEN | done | ✅ Complete |
| 2. CAS-style removeController (P1) | done | GREEN | done | ✅ Complete |
| 3. session.terminated Flag (P2) | done | GREEN | done | ✅ Complete |

## Next Step
→ All scenarios implemented and verified. PR ready.
