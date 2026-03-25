# Rich Turn Notification — Vertical Trace

> STV Trace | Created: 2026-03-26
> Spec: docs/rich-turn-notification/spec.md

## Table of Contents
1. [Scenario 1 — TurnCompletionEvent 인터페이스 확장](#scenario-1)
2. [Scenario 2 — stream-executor에서 리치 데이터 전달](#scenario-2)
3. [Scenario 3 — SlackBlockKitChannel 리치 렌더링](#scenario-3)

---

## Scenario 1 — TurnCompletionEvent 인터페이스 확장

### 1. Entry Point
- File: `src/turn-notifier.ts`
- Interface: `TurnCompletionEvent` (line 17)

### 2. Input
기존 필드 유지 + 옵셔널 리치 필드 추가:
```typescript
// 신규 옵셔널 필드
persona?: string;
model?: string;
startedAt?: Date;
contextUsagePercent?: number;
contextUsageDelta?: number;
contextUsageTokens?: number;
contextWindowSize?: number;
fiveHourUsage?: number;
fiveHourDelta?: number;
sevenDayUsage?: number;
sevenDayDelta?: number;
toolStats?: Record<string, { count: number; totalDurationMs: number }>;
```

### 3. Layer Flow

#### 3a. Interface Definition (turn-notifier.ts)
- `TurnCompletionEvent` interface에 12개 옵셔널 필드 추가
- 기존 필드 변경 없음
- Transformation: 없음 (타입 정의만)

### 4. Side Effects
- 없음 (타입 정의 변경만)

### 5. Error Paths
- 없음 (컴파일 타임 검증)

### 6. Output
- 확장된 인터페이스가 export됨

### 7. Observability
- N/A

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `TurnCompletionEvent accepts rich fields` | Contract | Scenario 1, Section 2 |

---

## Scenario 2 — stream-executor에서 리치 데이터 전달

### 1. Entry Point
- File: `src/slack/pipeline/stream-executor.ts`
- Method: `executeStream()` (line ~581, turnNotifier.notify 호출 위치)

### 2. Input
이미 존재하는 로컬 변수들:
- `requestStartedAt: Date` (line 221)
- `contextUsagePercentBefore: number | undefined` (line 222)
- `toolStats: RequestToolStats` (line 231)
- `usageBeforePromise: Promise<ClaudeUsageSnapshot | null>` (line 223)
- `session: ConversationSession` (model 포함)
- `user: string` (userId)

### 3. Layer Flow

#### 3a. 데이터 수집 (stream-executor.ts, executeStream 메서드 내)

턴 완료 시점 (line ~576-588)에서 추가 데이터 수집:

```
Transformation arrows:
  requestStartedAt → event.startedAt
  userSettingsStore.getUserPersona(user) → event.persona
  session.model || userSettingsStore.getUserDefaultModel(user) → event.model
  contextUsagePercentAfter (from getContextUsagePercentFromResult) → event.contextUsagePercent
  contextUsagePercentAfter - contextUsagePercentBefore → event.contextUsageDelta
  session.usage.currentInputTokens + currentOutputTokens → event.contextUsageTokens
  session.usage.contextWindow → event.contextWindowSize
  usageAfter.fiveHour → event.fiveHourUsage
  usageAfter.fiveHour - usageBefore.fiveHour → event.fiveHourDelta
  usageAfter.sevenDay → event.sevenDayUsage
  usageAfter.sevenDay - usageBefore.sevenDay → event.sevenDayDelta
  toolStats → event.toolStats
```

#### 3b. 이벤트 발행
- `this.deps.turnNotifier.notify(event)` — 기존 호출에 추가 필드 포함

주의: `usageAfter` 취득을 위해 `fetchClaudeUsageSnapshot(0)` await 필요.
이미 `buildFinalResponseFooter` 콜백(line 496)에서 동일 패턴 사용 중이므로,
턴 완료 알림 발행을 footer 빌드 이후로 이동하거나, 같은 usageAfter를 공유.

### 4. Side Effects
- 없음 (이벤트 객체에 데이터 추가만)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| usageAfter fetch 실패 | catch → null | fiveHourUsage/sevenDayUsage undefined → 렌더링 시 생략 |
| contextUsage 계산 불가 | undefined | contextUsagePercent undefined → 렌더링 시 생략 |

### 6. Output
- 확장된 `TurnCompletionEvent` 객체가 `turnNotifier.notify()`에 전달됨

### 7. Observability
- 기존 로그 유지: `Turn notification failed` (line 588)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `stream-executor passes rich data to turn notification` | Contract | Scenario 2, Section 3a |

---

## Scenario 3 — SlackBlockKitChannel 리치 렌더링

### 1. Entry Point
- File: `src/notification-channels/slack-block-kit-channel.ts`
- Method: `send(event: TurnCompletionEvent)` (line 23)

### 2. Input
- `event: TurnCompletionEvent` (확장된 인터페이스)

### 3. Layer Flow

#### 3a. 블록 구성 (slack-block-kit-channel.ts, send 메서드)

헤더 블록 (기존):
```
event.category → emoji + label → section block text
```

컨텍스트 블록들 (신규 렌더링):
```
Line 1: event.persona → ` `persona` ` | event.model → ` `model` `
Line 2: event.sessionTitle → "세션: {title}"
Line 3: event.startedAt + event.durationMs → ":alarm_clock: 시작 → 종료 (경과)"
Line 4: event.contextUsagePercent + contextUsageDelta + contextUsageTokens + contextWindowSize
         → "Ctx ▓░░░ 160.3k/1M (84.0%) +5.6"
Line 5 (조건부): event.fiveHourUsage/sevenDayUsage → "5h ▓▓░░ 42% +20 | 7d ▓▓▓░░ 55% +2"
Line 6 (조건부): event.toolStats → ":wrench: Tool×N: Xs | Tool×N: Xs"
```

#### 3b. 포맷 유틸리티 함수 (slack-block-kit-channel.ts에 private 추가)

```
renderBar(percent, width) → "▓▓▓░░░░░"
formatClock(date) → "오전 12:14:00"
formatElapsed(ms) → "17:28"
formatTokens(tokens) → "160.3k" | "1M"
formatSignedDelta(delta, decimals) → "+5.6" | "-3"
formatToolStatsRich(stats) → "Bash×59: 767.4s | WebFetch×7: 118.2s"
```

Transformation arrows:
```
event.persona → backtick-wrapped string in context block
event.model → backtick-wrapped string in context block
event.startedAt → formatClock() → "오전 12:14:00"
event.startedAt + event.durationMs → endedAt → formatClock() → "오전 12:31:28"
event.durationMs → formatElapsed() → "17:28"
event.contextUsageTokens → formatTokens() → "160.3k"
event.contextWindowSize → formatTokens() → "1M"
event.contextUsagePercent → renderBar() → "▓░░░░"
event.contextUsageDelta → formatSignedDelta(delta, 1) → "-5.6"
event.fiveHourUsage → renderBar() + formatPercent → "▓▓▓░░░ 42%"
event.fiveHourDelta → formatSignedDelta(delta, 0) → "+20"
event.toolStats → sort by totalDurationMs desc → top 5 → "Name×count: Xs"
```

### 4. Side Effects
- Slack API `postMessage` 호출 (기존과 동일, 내용만 변경)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| postMessage 실패 | catch | logger.warn, 무시 (기존 패턴) |
| 리치 필드 모두 undefined | graceful | 기존 포맷으로 폴백 |

### 6. Output
Slack 메시지 포맷:
```
:large_green_circle: *작업 완료*
|  `default`  |  `opus-4.6`
| 세션: PR #77 리뷰 및 수정
| :alarm_clock: 오전 12:14:00 → 오전 12:31:28 (17:28)
| Ctx  ▓░░░░ 160.3k/1M (84.0%) -5.6%
| 5h ▓▓▓░░░ 42% +20 | 7d ▓▓▓▓░░░░ 55% +2
| :wrench: Bash×59: 767.4s | WebFetch×7: 118.2s | Task×2: 17.2s
```

### 7. Observability
- 기존: `logger.warn('Failed to post Block Kit notification')`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `renders rich format with all fields` | Happy Path | Scenario 3, Section 3a full |
| `renders persona and model line` | Contract | Scenario 3, Section 3a Line 1 |
| `renders clock range line` | Contract | Scenario 3, Section 3a Line 3 |
| `renders context usage bar` | Contract | Scenario 3, Section 3a Line 4 |
| `renders 5h/7d usage only when available` | Contract | Scenario 3, Section 3a Line 5 |
| `omits 5h/7d when not available` | Sad Path | Scenario 3, Section 5 |
| `renders tool stats with durations sorted desc` | Contract | Scenario 3, Section 3a Line 6 |
| `falls back to simple format when no rich data` | Sad Path | Scenario 3, Section 5 |
| `formatTokens formats correctly` | Contract | Scenario 3, Section 3b |
| `renderBar renders correct bar width` | Contract | Scenario 3, Section 3b |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 유틸 함수를 channel 파일에 private 추가 | small | stream-executor의 동일 로직을 복제. 공통 유틸 추출은 향후 리팩터링 |
| context block 대신 mrkdwn section으로 렌더링 | tiny | Slack context block은 font size가 작음. 기존 패턴 유지하되 텍스트만 확장 |
| usageAfter를 footer 콜백과 공유 | small | 중복 API 호출 방지. 변수 스코프 조정만 필요 |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. TurnCompletionEvent 인터페이스 확장 | done | RED | Ready for stv:work |
| 2. stream-executor 리치 데이터 전달 | done | RED | Ready for stv:work |
| 3. SlackBlockKitChannel 리치 렌더링 | done | RED | Ready for stv:work |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work`
