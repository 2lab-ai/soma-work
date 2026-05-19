# Bug Trace: Session Restore Pattern Mismatch — "No conversation found" not caught

## AS-IS: "No conversation found with session ID: xxx" 에러 발생 시, 세션이 클리어되지 않고 보존되어 동일 에러로 3회 재시도 후 실패
## TO-BE: 해당 에러는 즉시 세션을 클리어하고, 다음 사용자 메시지에서 새 세션으로 시작해야 함

## Phase 1: Heuristic Top-3

### Hypothesis 1: isInvalidResumeSessionError 패턴이 실제 SDK 에러 메시지와 불일치
- `stream-executor.ts:1058-1069` → `isInvalidResumeSessionError()`
- 패턴: `['conversation not found', 'session not found', 'cannot resume', 'invalid resume', 'resume session']`
- SDK 에러 메시지 (lowercased): `"no conversation found with session id: 5f232806-..."`
- `"conversation not found"`.includes → `"no conversation found..."` 에 `"conversation not found"` 포함 여부?
  - `"no conversation found"` → "conversation" 후 "found" (not "not found")
  - `"conversation not found"` ≠ substring of `"no conversation found"`
  - ✅ **Confirmed** — 패턴 불일치가 근본 원인

### Hypothesis 2: isRecoverableClaudeSdkError가 먼저 매칭하여 short-circuit
- `stream-executor.ts:986-1006` → recoverablePatterns 확인
- `"no conversation found..."` 은 어떤 recoverable 패턴과도 일치하지 않음
- recoverable도 false → shouldClearSessionOnError의 최종 return이 `isInvalidResumeSessionError(error)` = false
- ❌ Ruled out (short-circuit은 아니지만, 결과적으로 false가 되어 같은 효과)

### Hypothesis 3: PR #104 sessionWorkingDir 수정 미적용
- `git log` 확인 → `f96ee2e` (PR #104) 이미 머지됨
- `session-registry.ts:1147` → sessionWorkingDir 직렬화 존재
- ❌ Ruled out — 이전 버그는 수정됨. 이번은 새로운 진입점

## Conclusion: Hypothesis 1 확인

**shouldClearSessionOnError 흐름도**:
```
error: "No conversation found with session ID: xxx"
  → isSlackApiError? NO
  → isImageProcessingError? NO
  → isContextOverflowError? NO
  → isRecoverableClaudeSdkError? NO
  → isInvalidResumeSessionError? NO ← 패턴 불일치!
  → return false (세션 보존)
  → auto-retry 3회 (같은 깨진 sessionId 유지)
  → 동일 에러 반복
```

## Edge Cases

1. SDK가 에러 메시지 형식을 바꾸면 또 빠질 수 있음 → fallback 전략 필요
2. shouldClearSessionOnError의 default가 false → 미인식 에러는 모두 세션 보존 → 위험

## Fix Plan

### Change 1: isInvalidResumeSessionError 패턴 추가 (stream-executor.ts:1061)
```typescript
const invalidSessionPatterns = [
  'no conversation found',   // ← ADD: exact SDK error message
  'conversation not found',
  'session not found',
  'cannot resume',
  'invalid resume',
  'resume session',
];
```

### Change 2: shouldClearSessionOnError default 변경 (stream-executor.ts:932-954)
기존: `return this.isInvalidResumeSessionError(error);`
변경: `return true;` — 미인식 에러는 세션 클리어가 안전

근거: 미인식 에러로 세션을 보존하면 같은 에러가 무한 반복될 위험이 크다.
세션 클리어의 비용(대화 컨텍스트 유실)은 무한 에러 루프보다 낫다.

## Verification Plan

### RED (수정 전)
- [ ] "no conversation found" 에러에 대해 isInvalidResumeSessionError가 false 반환 확인

### GREEN (수정 후)
- [ ] "no conversation found" 에러에 대해 isInvalidResumeSessionError가 true 반환 확인
- [ ] shouldClearSessionOnError가 미인식 에러에 대해 true 반환 확인
- [ ] 기존 테스트 통과
