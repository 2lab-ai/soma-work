# Rich Turn Notification — Spec

> STV Spec | Created: 2026-03-26

## 1. Overview

세션 턴 완료 시 Slack 스레드에 게시되는 상태 메시지를 개선한다. 현재 단순한 "세션: X | 소요: Ns" 포맷을 persona, model, 시간 범위, 컨텍스트 사용량, API rate limit, 도구 사용 통계를 포함하는 리치 포맷으로 확장한다.

stream-executor의 `buildFinalResponseFooter()`에 이미 모든 데이터가 계산되어 있으나, `TurnCompletionEvent` 인터페이스가 빈약하여 `SlackBlockKitChannel`까지 전달되지 않는 것이 근본 원인이다.

## 2. User Stories

- As a 운영자, I want 턴 완료 알림에서 어떤 persona/model이 사용되었는지 즉시 확인하고 싶다.
- As a 운영자, I want 세션 시작~종료 시간과 경과 시간을 한눈에 보고 싶다.
- As a 운영자, I want 컨텍스트 윈도우 사용량과 변화량을 시각적 바로 확인하고 싶다.
- As a 운영자, I want API rate limit(5h/7d) 상태를 조건부로 확인하고 싶다.
- As a 운영자, I want 도구별 호출 횟수와 소요 시간을 상세히 보고 싶다.

## 3. Acceptance Criteria

- [ ] 턴 완료 메시지에 persona와 model이 `` `backtick` `` 포맷으로 표시됨
- [ ] 세션 제목이 별도 줄로 표시됨
- [ ] 시작/종료 시각이 `오전/오후 HH:MM:SS → HH:MM:SS (M:SS)` 포맷으로 표시됨
- [ ] 컨텍스트 사용량이 `Ctx ▓░░░░ XX.X% +Y.Y` 바 그래프로 표시됨
- [ ] 5h/7d rate limit은 해당 데이터가 있을 때만 표시됨
- [ ] 도구 사용 통계가 `도구명×횟수: 소요시간s` 포맷으로 표시됨 (상위 N개 + 소요시간 내림차순)
- [ ] 기존 테스트가 깨지지 않음
- [ ] 새로운 렌더링 로직에 대한 단위 테스트 존재

## 4. Scope

### In-Scope
- `TurnCompletionEvent` 인터페이스 확장 (옵셔널 필드 추가)
- `stream-executor.ts`에서 이벤트에 리치 데이터 전달
- `slack-block-kit-channel.ts`에서 리치 포맷 렌더링
- 단위 테스트

### Out-of-Scope
- 다른 NotificationChannel 구현체 변경
- TurnCategory별 분기 (모든 카테고리에 동일 포맷)
- 새로운 데이터 수집 로직 추가 (이미 존재하는 데이터만 활용)

## 5. Architecture

### 5.1 Layer Structure

```
stream-executor.ts (데이터 수집 + 이벤트 발행)
  → turn-notifier.ts (이벤트 라우팅)
    → slack-block-kit-channel.ts (리치 렌더링)
```

### 5.2 Interface Changes

**`TurnCompletionEvent` 확장 (src/turn-notifier.ts)**:
```typescript
export interface TurnCompletionEvent {
  // 기존 필드
  category: TurnCategory;
  userId: string;
  channel: string;
  threadTs: string;
  sessionTitle?: string;
  durationMs: number;
  // 신규 옵셔널 필드
  persona?: string;
  model?: string;
  startedAt?: Date;
  contextUsagePercent?: number;
  contextUsageDelta?: number;
  contextUsageTokens?: number;  // e.g. 160300 (160.3k)
  contextWindowSize?: number;   // e.g. 1000000 (1M)
  fiveHourUsage?: number;       // 0-100
  fiveHourDelta?: number;
  sevenDayUsage?: number;       // 0-100
  sevenDayDelta?: number;
  toolStats?: Record<string, { count: number; totalDurationMs: number }>;
}
```

### 5.3 Data Flow

1. `stream-executor.ts` 턴 완료 시점 (line ~581):
   - `requestStartedAt` → `startedAt`
   - `userSettingsStore.getUserPersona(userId)` → `persona`
   - `session.model || userSettingsStore.getUserDefaultModel(userId)` → `model`
   - `contextUsagePercentAfter` → `contextUsagePercent`
   - `contextUsagePercentAfter - contextUsagePercentBefore` → `contextUsageDelta`
   - `usageAfter` → `fiveHourUsage`, `sevenDayUsage`
   - `usageBefore + usageAfter` → `fiveHourDelta`, `sevenDayDelta`
   - `toolStats` → `toolStats`

2. `turn-notifier.ts`: 변경 없음 (이벤트 패스스루)

3. `slack-block-kit-channel.ts`: 리치 렌더링 로직 추가

### 5.4 Rendering Format

```
:large_green_circle: *작업 완료*
|  `default`  |  `opus-4.6`
| 세션: PR #77 리뷰 및 수정
| :alarm_clock: 오전 12:14:00 → 오전 12:31:28 (17:28)
| Ctx  ▓░░░░ 160.3k/1M (84.0%) -5.6%
| 5h ▓▓▓░░░ 42% +20 | 7d ▓▓▓▓░░░░ 55% +2
| :wrench: Bash×59: 767.4s | WebFetch×7: 118.2s | Task×2: 17.2s
```

- 5h/7d 줄: `fiveHourUsage` 또는 `sevenDayUsage` 중 하나라도 있을 때만 표시
- tool stats 줄: `toolStats`가 있을 때만 표시, 소요시간 내림차순 정렬, 상위 5개

## 6. Non-Functional Requirements

- Performance: 추가 API 호출 없음 (이미 계산된 데이터 전달만)
- Security: 민감 정보 없음
- Backward Compatibility: 신규 필드 모두 옵셔널 — 기존 코드 영향 없음

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 신규 필드 모두 옵셔널로 추가 | tiny | 기존 코드 0줄 변경. 하위 호환 100% |
| Slack Block Kit attachment 구조 유지 | tiny | 기존 패턴 그대로. color + blocks |
| stream-executor에서 usageAfter를 await | small | 이미 footer 빌드 시 동일 패턴 사용 중 (line 496) |
| 도구 통계 상위 5개 + 소요시간 내림차순 | tiny | 표시 공간 제한. 변경 시 상수 1개 |
| context token 표시에 k/M 단위 사용 | tiny | 가독성. 포맷 함수 1개 |
| renderBar 로직 재사용 | small | stream-executor에 이미 구현됨. 공통 유틸로 추출하거나 channel에 복제 |

## 8. Open Questions

None — 요구사항 명확, 데이터 소스 확인 완료, 아키텍처 변경 최소.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/rich-turn-notification/spec.md`
