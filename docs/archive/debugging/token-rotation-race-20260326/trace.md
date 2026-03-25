# Bug Trace: Token Rotation Race Condition

## AS-IS: 2개 토큰(cct1, cct2) 운영 중 다중 세션이 동시에 rate limit → 2번 로테이션되어 제한된 토큰으로 복귀
## TO-BE: 세션 A가 로테이션 완료 후 세션 B는 이미 변경됨을 인지하고 중복 로테이션하지 않아야 함

## Phase 1: Heuristic Top-3

### Hypothesis 1: tryRotateToken이 쿼리 시작 시점이 아닌 에러 시점의 env를 읽음
- `stream-executor.ts:887` → `const failedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;`
- 이 시점에 env는 세션 A가 이미 cct2로 변경한 상태
- 세션 B가 cct2를 실패 토큰으로 전달 → `tokenManager.rotateOnRateLimit(cct2, ...)` → cct2에 cooldown 설정 → cct1로 복귀
- ✅ **확정** — 공유 전역 상태(process.env)를 에러 시점에 읽는 것이 원인

### Hypothesis 2: TokenManager.rotateOnRateLimit CAS 로직 결함
- `token-manager.ts:156` → `if (this.tokens[this.activeIndex].value !== failedTokenValue)` → CAS 자체는 정상
- 문제는 CAS에 전달되는 `failedTokenValue`가 오염된 것 ❌ CAS 로직은 정상

### Hypothesis 3: applyToken이 비동기적으로 env 반영
- `token-manager.ts:211-214` → `process.env.CLAUDE_CODE_OAUTH_TOKEN = this.tokens[this.activeIndex].value;`
- 동기적 할당이므로 타이밍 이슈 아님 ❌ 관련 없음

## Conclusion: Hypothesis 1 확정

### Root Cause
`tryRotateToken`이 `process.env.CLAUDE_CODE_OAUTH_TOKEN`을 읽지만, 이 값은 다른 세션의 로테이션으로 이미 변경됐을 수 있다.
쿼리 시작 시점의 토큰 값을 캡처하여 에러 핸들러까지 전달해야 한다.

### Fix Plan
1. `execute()` 시작 시 `tokenManager.getActiveToken().value`를 캡처
2. `handleError` 시그니처에 `queryTokenValue` 파라미터 추가
3. `tryRotateToken`에서 `process.env` 대신 캡처된 값 사용
