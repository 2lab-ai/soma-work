# Auto-Resume Interrupted Sessions — Spec

> STV Spec | Created: 2026-03-26

## 1. Overview

서버 재시작 시 모델이 작업 중이던(endTurn 전) 세션을 자동으로 재개하는 기능.
현재는 "재시작되었습니다. 다시 시도해주세요"라는 알림만 보내고 끝나지만,
`activityState === 'working'`이었던 세션에 대해서는 자동으로 resume prompt를 전달하여
모델이 스스로 컨텍스트를 복원하고 작업을 이어가도록 한다.

## 2. User Stories

- As a user, I want my interrupted work to automatically continue after a server restart, so that I don't have to manually re-trigger the task.
- As a system operator, I want only actively-working sessions to auto-resume (not those waiting for user input), so that the system doesn't send unwanted messages.

## 3. Acceptance Criteria

- [ ] `activityState === 'working'`인 세션만 auto-resume 대상
- [ ] `activityState === 'waiting'` 또는 `'idle'`인 세션은 기존 알림만 전송
- [ ] Auto-resume 시 기존 sessionId를 사용하여 대화 연속성 유지
- [ ] Resume prompt: "slack-thread → get_thread_messages 이거로 유저의 마지막 명령까지 대화를 확인하고 네가 한 작업일 이어서 진행해줘"
- [ ] 다수 세션 auto-resume 시 순차 처리 + 세션 간 딜레이(2초)
- [ ] Auto-resume 실패가 서버 시작을 블로킹하지 않음
- [ ] Auto-resume 시도/성공/실패에 대한 로깅

## 4. Scope

### In-Scope
- `notifyCrashRecovery()` 수정: 'working' 세션에 대한 auto-resume 로직 추가
- `CrashRecoveredSession` 타입에 `sessionKey` 필드 추가 (handleMessage 호출에 필요)
- Synthetic `MessageEvent` 생성하여 기존 `handleMessage()` 파이프라인 재사용
- 에러 핸들링 및 로깅

### Out-of-Scope
- 'waiting' 상태 세션의 자동 재개
- Resume 실패 시 재시도 메커니즘
- Resume prompt 커스터마이징 UI
- 세션 상태 머신 변경

## 5. Architecture

### 5.1 Layer Structure

```
index.ts (startup)
  → slackHandler.notifyCrashRecovery()
    → [기존] 알림 메시지 전송
    → [신규] 'working' 세션 → autoResumeSession()
      → synthetic MessageEvent 생성
      → handleMessage(syntheticEvent, noopSay) 호출
        → 기존 파이프라인 (InputProcessor → SessionInitializer → StreamExecutor)
        → options.resume = session.sessionId (자동)
```

### 5.2 API Endpoints

해당 없음 (내부 로직 변경만)

### 5.3 Data Changes

**CrashRecoveredSession 타입 확장:**
```typescript
export interface CrashRecoveredSession {
  channelId: string;
  threadTs?: string;
  ownerId: string;
  ownerName?: string;
  activityState: string;
  sessionKey: string;  // 추가: handleMessage에서 세션 lookup용
}
```

### 5.4 Integration Points

| Component | Integration |
|-----------|------------|
| `session-registry.ts` | CrashRecoveredSession에 sessionKey 추가, loadSessions()에서 수집 |
| `slack-handler.ts` | notifyCrashRecovery()에 auto-resume 로직 추가 |
| `handleMessage()` | Synthetic MessageEvent로 기존 파이프라인 재사용 |
| `claude-handler.ts` | 변경 없음 (기존 resume 메커니즘 그대로 사용) |

## 6. Non-Functional Requirements

- **Performance**: 세션 간 2초 딜레이로 시스템 부하 분산
- **Reliability**: auto-resume 실패가 다른 세션이나 서버 시작에 영향 없음 (fire-and-forget)
- **Observability**: auto-resume 시도/성공/실패 로깅

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| `handleMessage()` 직접 호출로 파이프라인 재사용 | small (~20) | 새 파이프라인 경로를 만들지 않고 기존 메시지 처리 흐름을 그대로 탄다. SessionInitializer가 기존 세션을 찾고, StreamExecutor가 resume 옵션을 자동 설정. |
| CrashRecoveredSession에 sessionKey 추가 | small (~20) | handleMessage가 세션을 찾으려면 channel+threadTs 기반 key가 필요. 기존 타입에 필드 하나 추가. |
| 세션 간 딜레이 2초 | tiny (~5) | 동시 다발적 resume가 API rate limit이나 리소스 경쟁을 일으킬 수 있음. 2초면 충분. |
| Synthetic MessageEvent의 user 필드를 session.ownerId로 설정 | tiny (~5) | 세션 소유자의 요청으로 처리되어야 권한/컨텍스트가 맞음. |
| Resume prompt 텍스트 고정 | tiny (~5) | 유저가 직접 지정한 프롬프트 사용. |

## 8. Open Questions

None — 유저 요구사항이 명확하고, 기존 아키텍처가 이 변경을 자연스럽게 수용한다.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace`
