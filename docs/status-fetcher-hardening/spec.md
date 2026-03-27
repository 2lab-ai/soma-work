# Status Fetcher Hardening — Spec

> STV Spec | Created: 2026-03-28
> Parent: Issue #120 (Codex review round 2)
> Debug: docs/debugging/codex-review2-202603281000/trace.md

## 1. Overview

PR #115 머지 후 Codex 리뷰에서 발견된 production-impacting 결함 수정:
- negative cache 부재 (장애 시 반복 fetch)
- incident status scoping drift (multi-incident)
- 테스트 커버리지 3건 부족

## 2. Acceptance Criteria

- [ ] S1: Negative cache — fetch 실패 시 30초 backoff, 재시도 전까지 null 반환
- [ ] S2: Incident scoping — 다음 incident-container 경계까지만 updates 탐색
- [ ] S3: stream-executor 통합 테스트 — formatErrorForUser에서 statusInfo 가드 동작 검증
- [ ] S4: non-OK HTTP response 테스트
- [ ] S5: incident status 값 검증 테스트
- [ ] 기존 테스트 regression 없음
- [ ] tsc 0 errors

## 3. Scope

### In-Scope
- `claude-status-fetcher.ts` — negative cache, incident scoping fix
- `claude-status-fetcher.test.ts` — S1, S2, S4, S5 테스트
- `stream-executor.test.ts` — S3 통합 테스트

### Out-of-Scope
- resolved incident 필터링, isApiLikeError 범위 축소, JSON API 전환

## 4. Architecture

### 4.1 S1: Negative Cache
```typescript
// Add negative cache entry
const NEGATIVE_CACHE_TTL = 30 * 1000; // 30 seconds
let lastFailedAt = 0;

// In doFetch catch:
lastFailedAt = Date.now();

// In fetchClaudeStatus:
if (!cached && lastFailedAt && Date.now() - lastFailedAt < NEGATIVE_CACHE_TTL) {
  return null; // backoff
}
```

### 4.2 S2: Incident Scoping
```typescript
// Before: slices to end of HTML
const afterMatch = html.slice(match.index + match[0].length);

// After: slice only to next incident-container
const afterMatch = html.slice(match.index + match[0].length);
const nextIncident = afterMatch.indexOf('incident-container');
const scopedHtml = nextIncident > 0 ? afterMatch.slice(0, nextIncident) : afterMatch;
const updatesMatch = scopedHtml.match(/<div\s+class="updates"[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/);
```

## 5. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 30초 negative TTL | small | 2분 positive TTL의 1/4. 장애 복구 후 빠른 재시도 허용 |
| incident-container boundary | small | 완벽하지 않으나 현 구조에서 가장 안전한 scoping |
| stream-executor 통합은 mock 기반 | small | private method 직접 테스트 대신 public API 기반 |
