# MCP Session Tick — Status Update 구조 개선 Spec

> STV Spec | Created: 2026-03-04

## 1. Overview

MCP 호출마다 개별 `setInterval` 타이머를 생성하는 현재 구조를 **session-level 단일 tick** 기반으로 전환한다. MCP 완료 처리가 누락되어도 타이머가 누적되지 않으며, adaptive backoff로 장기 실행 호출의 update 빈도를 자동 감소시킨다.

**왜 필요한가**: stuck MCP 호출(12시간+)이 per-call 타이머로 status update를 무한 생성 → Slack API 큐 2,000+건 적체 → 봇 응답 불가.

## 2. User Stories

- As a 봇 운영자, I want MCP status update가 큐를 폭주시키지 않기를, so that 봇이 항상 응답 가능하다
- As a Slack 사용자, I want 장기 실행 MCP 호출의 상태를 볼 수 있기를, so that 작업 진행을 확인할 수 있다
- As a 개발자, I want MCP 호출이 2시간 이상 status update를 보내지 않기를, so that 리소스가 낭비되지 않는다

## 3. Acceptance Criteria

- [ ] per-call setInterval 제거, session-level 단일 tick으로 전환
- [ ] 세션 내 모든 MCP 호출을 하나의 Slack 메시지로 통합 렌더링
- [ ] 매 tick마다 최대 1회 Slack API 호출 (updateMessage)
- [ ] Adaptive backoff: 0-1m→10s, 1-10m→30s, 10-30m→1m, 30m+→5m
- [ ] 2시간 hard timeout: status update 자동 중단
- [ ] SlackApiHelper에 큐 크기 제한 (safety net)
- [ ] 기존 테스트 + 신규 테스트 통과

## 4. Scope

### In-Scope
- McpStatusDisplay 리팩터: per-call timer → session tick
- 통합 렌더링 (하나의 Slack 메시지에 모든 MCP 상태)
- Adaptive backoff 로직
- 2시간 hard timeout
- SlackApiHelper 큐 크기 제한 (safety net)
- ToolEventProcessor cleanup() 확장

### Out-of-Scope
- 세션 동시 실행 수 제한
- MCP 호출 자체의 강제 종료 (SDK 세션 손상 위험)
- McpCallTracker 변경 (elapsed 추적은 현재 그대로)
- StatusReporter 변경 (이미 WebClient 직접 사용)

## 5. Architecture

### 5.1 현재 구조 (문제)

```
MCP call 1 → setInterval(30s) → updateMessage → queue
MCP call 2 → setInterval(30s) → updateMessage → queue
MCP call 3 → setInterval(10s) → updateMessage → queue  (group)
...
N개 타이머 × 무한 실행 = 큐 폭주
```

### 5.2 목표 구조

```
Session
  └─ SessionTick (단일 setInterval)
       ├─ tick() → 활성 MCP 호출 목록 순회
       │     ├─ adaptive interval 계산 (최소값 사용)
       │     ├─ timeout 체크 (2시간 초과 → 제거)
       │     └─ 통합 메시지 렌더 → 1회 updateMessage
       └─ MAX 1 Slack API call per tick
```

### 5.3 Adaptive Backoff Schedule

| Elapsed | Tick Interval | 근거 |
|---------|--------------|------|
| 0 ~ 1분 | 10초 | 짧은 호출은 빠른 피드백 |
| 1 ~ 10분 | 30초 | 중간 호출, 적당한 빈도 |
| 10 ~ 30분 | 1분 | 장기 호출, 낮은 빈도 |
| 30분 ~ 2시간 | 5분 | 매우 긴 호출, 최소 빈도 |
| 2시간+ | TIMEOUT | status update 중단 |

**Tick interval 결정**: 활성 호출 중 가장 짧은 adaptive interval 사용.

### 5.4 통합 메시지 렌더링

하나의 Slack 메시지에 모든 활성 MCP 호출 상태를 표시:

```
📊 3개 작업 실행 중 (1/3 완료)

🟢 codex → search (3.2s)
⏳ jira → createIssue — 2분 15초 ████████░░░░░░░░░░░░
⏳ gemini → query — 45초 ██████████████░░░░░░
```

- 첫 MCP 호출 등록 시 `postMessage`로 생성 (1회)
- 이후 tick마다 `updateMessage`로 갱신
- 모든 호출 완료 시 최종 렌더 후 tick 중단

### 5.5 Round-Robin (매 tick 1회 제한)

통합 모드에서는 하나의 메시지만 업데이트하므로 자연스럽게 **1 API call / tick / session**.

7개 세션 × 10초 tick = 0.7 calls/s → rate limit(3/s) 이내.

### 5.6 Queue Safety Net

SlackApiHelper에 `maxQueueSize` 추가 (기본: 200). 초과 시 oldest 항목 drop + warn 로그.
이는 session tick 외의 다른 원인으로 큐가 쌓이는 것을 방지하는 safety net.

### 5.7 Integration Points

| 기존 코드 | 변경 |
|-----------|------|
| `McpStatusDisplay` | per-call timer 제거, session tick + 통합 렌더 |
| `ToolEventProcessor` | `startMcpTracking` API 변경 (timer 시작 → 호출 등록만), `cleanup()` 확장 |
| `SlackApiHelper` | `maxQueueSize` + overflow drop |
| `StreamExecutor` | McpStatusDisplay 생성 시 session context 전달 (이미 하고 있음) |

## 6. Non-Functional Requirements

- **Performance**: 7 세션 동시 실행 시 Slack API 0.7 calls/s 이내
- **Reliability**: MCP 완료 누락 → 2시간 후 자동 정리, 큐 200 초과 불가
- **Observability**: timeout된 호출 warn 로그, 큐 overflow warn 로그

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Tick 위치: McpStatusDisplay 내부 리팩터 | small | 기존 API surface 유지, 새 클래스 불필요 |
| Adaptive 주기 상수값 | tiny | 유저 명시, config 변경만 |
| Timeout 2시간 | tiny | 유저 명시 |
| 큐 maxQueueSize=200 | tiny | 3/s 기준 66초 backlog, 안전한 상한 |
| 큐 overflow 시 oldest drop | small | priority queue보다 단순, safety net용으로 충분 |
| MCP 호출 강제 종료 안함 | small | SDK 세션 손상 위험, status update만 중단 |

## 8. Open Questions

None — 유저가 핵심 요구사항을 모두 명시함.

## 9. Next Step

→ `stv:trace` 로 Vertical Trace 진행
