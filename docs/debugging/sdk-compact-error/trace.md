# Bug Trace: SDK Context Overflow — Error Swallowed + No Auto-Compact

## AS-IS
1. Context overflow 에러 시 `error.stderrContent`가 유저에게 안 보임 (generic message만)
2. SDK auto-compact 이벤트(`compact_boundary`, `status: compacting`)가 stream-processor에서 무시됨
3. Context overflow → session cleared → 대화 기록 전부 소실

## TO-BE
1. SDK에서 받는 모든 에러 상세(stderrContent, errors[]) 유저에게 출력
2. SDK auto-compact 이벤트 인식 및 처리
3. Context 가득 차면 compact로 대화 압축하여 계속 진행

---

## Phase 1: Heuristic Top-3

### Hypothesis 1: stream-processor.ts가 'system' 타입 메시지를 완전히 무시 ✅ CONFIRMED
- `stream-processor.ts:263-279` → message type 분기:
  ```
  if (message.type === 'assistant') { ... }
  else if (message.type === 'user') { ... }
  else if (message.type === 'result') { ... }
  // 'system' 타입 → drop됨!
  ```
- SDK `SDKCompactBoundaryMessage`: `{ type: 'system', subtype: 'compact_boundary', compact_metadata: {...} }`
- SDK `SDKStatusMessage`: `{ type: 'system', subtype: 'status', status: 'compacting' }`
- 둘 다 stream-processor의 for-await 루프에서 그냥 버려짐

### Hypothesis 2: formatErrorForUser가 stderrContent를 출력하지 않음 ✅ CONFIRMED
- `stream-executor.ts:1149-1200` → `formatErrorForUser()`:
  ```typescript
  const errorMessage = error.message || 'Something went wrong';
  const lines = [`❌ *[Bot Error]* ${errorMessage}`, ...];
  ```
- `error.stderrContent`는 `claude-handler.ts:601-603`에서 error 객체에 첨부되지만:
  ```typescript
  if (stderrBuffer) {
    (error as any).stderrContent = stderrBuffer;
  }
  ```
- `formatErrorForUser`에서 `stderrContent`를 **절대 출력하지 않음**
- `isRecoverableClaudeSdkError`/`isRateLimitError`에서만 내부 패턴매칭에 사용

### Hypothesis 3: handleResultMessage가 error subtype을 무시 ✅ CONFIRMED
- `stream-processor.ts:935-941` → `handleResultMessage()`:
  ```typescript
  if (message.subtype === 'success' && message.result) {
    // only handles success
  }
  // error subtypes: 'error_during_execution', 'error_max_turns', etc. → ignored
  ```
- SDK `SDKResultError` has `errors: string[]` field with detailed error list
- This array is never logged or shown to user

---

## Root Causes (3가지 모두 확인됨)

### RC-1: System message handler 부재
- **위치**: `stream-processor.ts:263-279`
- **원인**: `message.type === 'system'` 분기 없음
- **영향**: compact_boundary, status(compacting), init 등 모든 system 이벤트 무시

### RC-2: Error detail 미출력
- **위치**: `stream-executor.ts:1149-1200` (`formatErrorForUser`)
- **원인**: `error.stderrContent` 출력 로직 없음
- **영향**: 유저가 실제 에러 원인을 볼 수 없음

### RC-3: SDK result error 무시
- **위치**: `stream-processor.ts:909-943` (`handleResultMessage`)
- **원인**: `subtype === 'success'`만 처리, error subtype 무시
- **영향**: `SDKResultError.errors[]`에 담긴 상세 에러 정보 유실

---

## Fix Plan

### Fix 1: stream-processor.ts — system message handler 추가
- `compact_boundary` → 로그 + 유저에게 compact 알림
- `status: 'compacting'` → 상태 표시 업데이트

### Fix 2: formatErrorForUser — stderrContent 출력
- error.stderrContent가 있으면 축약하여 유저에게 표시

### Fix 3: handleResultMessage — error subtype 처리
- error subtype 분기 추가, errors[] 로그 출력
- 콜백을 통해 유저에게 에러 상세 전달
