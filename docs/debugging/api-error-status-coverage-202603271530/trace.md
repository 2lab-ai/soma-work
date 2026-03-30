# Bug Trace: api-error-status Test Coverage Deficiency

## AS-IS: PR #92 테스트 19개 존재하지만 Codex 평가 4/10. 핵심 production failure mode 미커버.
## TO-BE: 모든 HIGH 결함 수정, 통합 테스트 추가, 테스트 커버리지 8/10 이상

## Phase 1: Heuristic Top-5 (Codex 지적 검증)

### Bug 1: stream-executor 통합 테스트 0건 ✅ Confirmed
- `stream-executor.ts:867` → `this.formatErrorForUser(error, sessionCleared, statusInfo, retryAttempt)` 호출
- `stream-executor.ts:1119` → `formatErrorForUser()` private method, 4개 파라미터
- `stream-executor.ts:1165` → `if (statusInfo && statusInfo.overall !== 'operational')` 가드
- `claude-status-fetcher.test.ts:370-395` → "formatErrorForUser" 테스트 2건은 실제로 `formatStatusForSlack()`만 호출
- **결론**: formatErrorForUser의 statusInfo 통합 경로가 완전히 미테스트

### Bug 2: inflight coalescing 미테스트 ✅ Confirmed
- `claude-status-fetcher.ts:47` → `let inflight: Promise<ClaudeStatusInfo | null> | null = null`
- `claude-status-fetcher.ts:100-102` → `if (inflight) return inflight; inflight = doFetch().finally(...)`
- `claude-status-fetcher.test.ts` → 전체 검색: "inflight" 키워드 0건, 동시 호출 테스트 0건
- **결론**: stampede 방지 로직이 존재하지만 증명 없음

### Bug 3: regex 취약성 ✅ Confirmed
- `claude-status-fetcher.ts:119` → componentRegex: `class="component-container\s+(status-\w+)"`
  - 추가 class가 있으면 (`class="component-container other-class status-red"`) 매치 실패
  - `status-\w+` 캡처 그룹이 첫 번째 class만 잡음
- `claude-status-fetcher.ts:136` → incidentRegex: incident-title 뒤 updates div 매칭
  - 여러 인시던트가 있을 때 잘못된 updates 블록 참조 가능
- `claude-status-fetcher.test.ts:21-48` → HTML fixture가 구현 regex에 완벽히 일치하도록 수작업
- **결론**: regex가 실제 HTML 변형에 취약하고, 이를 검증하는 테스트 없음

### Bug 4: unknown 상태 → overall 'operational' 버그 ✅ Confirmed
- `claude-status-fetcher.ts:109-113` → `parseStatusColor()`: 인식 못하는 class → `'unknown'` 반환
- `claude-status-fetcher.ts:157-163` → overall 파생 로직:
  ```
  if (some outage) → 'outage'
  else if (some degraded) → 'degraded'
  else → 'operational'  // ← unknown이 여기로 빠짐!
  ```
- `stream-executor.ts:1165` → `statusInfo.overall !== 'operational'` 가드
- **결론**: 모든 컴포넌트 unknown → overall 'operational' → status 블록 숨김. 실제 장애인데 사용자에게 안 보임.

### Bug 5: operational + 활성 인시던트 = 숨김 ✅ Confirmed
- `claude-status-fetcher.ts:193` → `formatStatusForSlack`: operational + incidents=0이면 한 줄, 아니면 전체 표시
- `stream-executor.ts:1165` → `statusInfo.overall !== 'operational'` 가드
- **시나리오**: 모든 컴포넌트 green이지만 인시던트 진행 중 (Investigating) → overall='operational' → 가드가 차단 → 인시던트 정보 사용자에게 미표시
- **결론**: 인시던트가 있으면 overall이 operational이어도 표시해야 함

## 수정 방향

| Bug | 수정 |
|-----|------|
| Bug 1 | handleError 통합 테스트: API에러+상태, Slack에러 제외, null 상태 |
| Bug 2 | 동시 호출 테스트: 2개 병렬 fetch가 1회만 실행 확인 |
| Bug 3 | regex 강화 + 실제 HTML 변형 fixture 추가 |
| Bug 4 | overall 파생에서 unknown 처리 추가: `some(unknown) → 'unknown'` |
| Bug 5 | 가드 조건 수정: `overall !== 'operational' || incidents.length > 0` |
