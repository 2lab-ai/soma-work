# Spec: SDK "Operation aborted" Crash Defense

## Problem

SDK `handleControlRequest`의 fire-and-forget 패턴이 abort 후 `write()` 에서 unhandled rejection을 발생시켜 전체 프로세스를 crash.

### Root Cause Chain

1. `ClaudeHandler.streamQuery()` passes `canUseTool` callback → creates long-running `processControlRequest` (waits for Slack permission UI)
2. `RequestCoordinator.abortSession()` signals abort on transport
3. SDK's `handleControlRequest` (fire-and-forget async, no `.catch()`) tries `transport.write()` → throws
4. Catch block also tries `write()` → also throws → unhandled rejection → crash

### Existing Defenses (that failed)

- `process.on('uncaughtException')` handler exists BUT logger didn't flush before `process.exit(1)` — crash log shows NO output from handler
- 5-minute auto-save exists
- `SessionRegistry.saveSessions()` persists to `data/sessions.json`

## Solution: 3-Layer Defense

### Layer 1: Root Cause (canUseTool abort guard)
canUseTool 콜백에 abort signal 체크 추가. abort 되면 즉시 reject → SDK가 에러로 처리하고 write() 시도 전에 종료.

### Layer 2: Error Isolation (SDK query error wrapper)
streamQuery()의 for-await-of에서 "Operation aborted" 에러를 AbortError로 분류. StreamExecutor에서 abort 관련 에러 추가 격리.

### Layer 3: Crash Recovery
- uncaughtException/unhandledRejection 핸들러에서 `fs.writeFileSync`로 직접 세션 저장 (logger 의존 제거)
- 재시작 시 이전에 active 상태였던 세션의 유저에게 Slack DM으로 알림

## Task Breakdown

| ID | Task | Priority | Deps |
|----|------|----------|------|
| crash-1 | canUseTool abort guard | P0 | - |
| crash-2 | SDK query error wrapper + StreamExecutor 방어 | P0 | - |
| crash-3 | Process handler 동기 저장 개선 | P0 | - |
| crash-4 | 재시작 시 활성 세션 Slack 알림 | P1 | crash-3 |

## Sizing

**medium** (~50 lines total) — 4 files across 3 layers
