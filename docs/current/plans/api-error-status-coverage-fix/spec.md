# API Error Status — Test Coverage & Bug Fix

> STV Spec | Created: 2026-03-27
> Parent: PR #92 (feat: show Claude service status on API errors)

## 1. Overview

PR #92의 구현에서 Codex 리뷰로 발견된 5개 HIGH 결함을 수정한다:
- 코드 버그 2건 (unknown 상태 처리, operational+인시던트 숨김)
- 테스트 커버리지 부족 3건 (통합 테스트, inflight coalescing, regex 취약성)

## 2. Acceptance Criteria

- [ ] Bug 4 수정: unknown 컴포넌트 → overall 'unknown' (not 'operational')
- [ ] Bug 5 수정: overall 'operational'이라도 incidents.length > 0이면 status 표시
- [ ] 통합 테스트: handleError에서 API에러+상태정보 → status 블록 포함 확인
- [ ] inflight coalescing 테스트: 동시 2회 호출 → fetch 1회만 실행
- [ ] regex robustness 테스트: extra class, nested tag 등 실제 HTML 변형 fixture
- [ ] 테스트 격리: afterEach에서 unstubAllGlobals + useRealTimers
- [ ] 기존 19개 테스트 regression 없음
- [ ] tsc 0 errors

## 3. Scope

### In-Scope
- `claude-status-fetcher.ts` — overall 파생 로직 수정 (Bug 4)
- `stream-executor.ts` — statusInfo 가드 조건 수정 (Bug 5)
- `claude-status-fetcher.test.ts` — 테스트 추가 및 격리 수정
- `stream-executor.test.ts` — 통합 테스트 추가

### Out-of-Scope
- 새 기능 추가
- regex 전면 재작성 (점진적 강화만)

## 4. Architecture

변경 최소화. 기존 구조 유지, 버그 수정 + 테스트 보강만.

### 4.1 Bug 4 Fix — unknown 상태 처리
```typescript
// Before (claude-status-fetcher.ts:157-163)
let overall = 'operational';
if (components.some(c => c.status === 'outage')) overall = 'outage';
else if (components.some(c => c.status === 'degraded')) overall = 'degraded';

// After
let overall = 'operational';
if (components.some(c => c.status === 'outage')) overall = 'outage';
else if (components.some(c => c.status === 'degraded')) overall = 'degraded';
else if (components.some(c => c.status === 'unknown')) overall = 'unknown';
```

### 4.2 Bug 5 Fix — 인시던트 가드 조건
```typescript
// Before (stream-executor.ts:1165)
if (statusInfo && statusInfo.overall !== 'operational') {

// After
if (statusInfo && (statusInfo.overall !== 'operational' || statusInfo.incidents.length > 0)) {
```

## 5. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| regex 전면 교체 대신 fixture 다양화로 robustness 확보 | small | 파서 전면 재작성은 위험. 현재 regex가 실제 status.claude.com과 매칭되는지 fixture로 증명 |
| stream-executor 통합 테스트는 handleError mock 기반 | small | private method 직접 테스트보다 public API 기반 |
| test isolation은 afterEach에서 일괄 정리 | tiny | vitest best practice |
