# CCT Token Rotation — Spec

> STV Spec | Created: 2026-03-05

## 1. Overview

Claude Code OAuth 토큰을 여러 개 풀로 관리하여 rate limit 발생 시 자동으로 다음 토큰으로 전환하는 시스템.
현재 단일 `CLAUDE_CODE_OAUTH_TOKEN`으로 운영 중이며, 하나의 토큰이 limit에 걸리면 수동 대응이 필요한 문제를 해결한다.

## 2. User Stories

- As a bot admin, I want to configure multiple OAuth tokens so that the bot can automatically switch when one hits rate limits.
- As a bot admin, I want to see current token status (`cct`) so that I can monitor token health.
- As a bot admin, I want to manually switch tokens (`set_cct cctN`) so that I can preemptively manage capacity.
- As a Slack user, I want the bot to automatically recover from rate limits so that my conversation continues without manual intervention.

## 3. Acceptance Criteria

- [ ] `CLAUDE_CODE_OAUTH_TOKEN_LIST` 환경변수로 복수 토큰 로드 (comma-separated)
- [ ] 기존 단일 `CLAUDE_CODE_OAUTH_TOKEN`만 있으면 그대로 동작 (하위호환)
- [ ] cct1, cct2, cct3... 으로 명명, cct1이 기본 active
- [ ] `cct` 커맨드: 토큰 상태 출력 (마스킹, active 표시, cooldown 시간)
- [ ] `set_cct cctN` 커맨드: 수동 토큰 전환
- [ ] `ADMIN_USERS` 환경변수로 admin 유저 제한
- [ ] Rate limit 에러 감지 시 자동 토큰 전환
- [ ] "resets Xpm" 메시지에서 cooldown 시간 파싱
- [ ] 동시 세션에서의 idempotent 전환 (CAS 패턴)
- [ ] 모든 토큰이 cooldown이면 가장 빨리 복구되는 토큰 사용 + 유저에게 알림

## 4. Scope

### In-Scope
- TokenManager 싱글톤 모듈 (`src/token-manager.ts`)
- CctHandler 커맨드 (`src/slack/commands/cct-handler.ts`)
- Admin 유저 체크 유틸 (`src/admin-utils.ts`)
- stream-executor 에러 핸들링에 auto-rotation 훅
- config.ts에 token list + admin users 설정 추가
- 토큰 전환 시 Slack 알림

### Out-of-Scope
- 토큰 자동 갱신 (OAuth refresh) — 별도 피쳐
- 토큰별 사용량 통계/대시보드
- 유저별 토큰 할당

## 5. Architecture

### 5.1 Layer Structure

```
Slack Command (cct/set_cct)
  → CctHandler
    → TokenManager (singleton)
      → process.env.CLAUDE_CODE_OAUTH_TOKEN

Stream Error
  → StreamExecutor.handleError()
    → TokenManager.rotateOnRateLimit()
      → process.env.CLAUDE_CODE_OAUTH_TOKEN
```

### 5.2 Core Module: TokenManager

```typescript
// src/token-manager.ts — Singleton
interface TokenEntry {
  name: string;          // "cct1", "cct2", ...
  value: string;         // actual token value
  cooldownUntil: Date | null;  // null = available
}

class TokenManager {
  private tokens: TokenEntry[];
  private activeIndex: number;

  // Startup: load from CLAUDE_CODE_OAUTH_TOKEN_LIST or single token
  initialize(): void;

  // Get current active token info
  getActiveToken(): TokenEntry;
  getAllTokens(): readonly TokenEntry[];

  // Manual switch (set_cct)
  setActiveToken(name: string): boolean;

  // Auto-rotation on rate limit (idempotent CAS)
  rotateOnRateLimit(failedTokenValue: string, cooldownUntil: Date | null): RotationResult;

  // Apply active token to process.env
  private applyToken(): void;

  // Mask token for display
  static maskToken(value: string): string;
}
```

### 5.3 Idempotent Rotation (CAS Pattern)

Node.js 싱글스레드이므로 진짜 mutex는 불필요하나, 여러 세션의 에러가 동일 tick에서 처리될 수 있음.
`rotateOnRateLimit(failedTokenValue)` — 현재 active 토큰이 caller가 사용한 토큰과 일치할 때만 전환.
이미 다른 세션이 전환했으면 no-op 반환.

```
Session A: rate limit → rotateOnRateLimit("tokenA") → switches to tokenB ✅
Session B: rate limit → rotateOnRateLimit("tokenA") → tokenA != current → no-op ✅
```

### 5.4 Integration Points

| Component | Integration | Change Size |
|-----------|------------|-------------|
| `src/config.ts` | `CLAUDE_CODE_OAUTH_TOKEN_LIST`, `ADMIN_USERS` 추가 | ~10 lines |
| `src/slack/commands/command-router.ts` | CctHandler 등록 | ~3 lines |
| `src/slack/command-parser.ts` | `isCctCommand`, `parseCctCommand` 추가 | ~15 lines |
| `src/slack/pipeline/stream-executor.ts` | handleError에서 rate limit 시 TokenManager 호출 | ~20 lines |
| `src/index.ts` | TokenManager 초기화 | ~5 lines |

## 6. Non-Functional Requirements

- **Performance**: 토큰 전환은 O(N) where N=토큰 수 (3-5개 예상). 무시할 수준.
- **Security**: 토큰 값은 로그/출력 시 항상 마스킹. Admin 전용 커맨드.
- **Reliability**: 모든 토큰 cooldown 시 가장 빨리 복구되는 토큰 선택 + 경고 메시지.
- **Concurrency**: CAS 패턴으로 동시 전환 요청 안전 처리.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 파일명 `token-manager.ts` | tiny | 기존 `-manager.ts` 네이밍 패턴 답습 |
| CommandHandler 인터페이스 사용 | tiny | 모든 커맨드가 동일 패턴 |
| `process.env` 직접 변경 | tiny | SDK가 매 query() 호출 시 env 읽음 |
| 토큰 마스킹 `sk-a...xyz` | tiny | 표준 마스킹 패턴 |
| CAS 기반 idempotent 전환 | small | Node.js 싱글스레드에서 충분 |
| Round-robin 순환 | tiny | 최단 cooldown 토큰 우선 선택으로 개선 |
| config.ts 통합 | tiny | 기존 env var 패턴 그대로 |
| admin-utils.ts 분리 | small | 재사용 가능한 admin 체크 유틸 |

## 8. Open Questions

None — 모든 결정 확정됨.

## 9. Next Step

→ `stv:trace` 로 Vertical Trace 진행
