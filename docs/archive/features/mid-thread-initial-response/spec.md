# Mid-Thread 멘션 시 초기 응답 유지 + 원본 스레드 추적 — Spec

> STV Spec | Created: 2026-03-24 | Updated: 2026-03-24 | GitHub Issue: #64

## 1. Overview

봇이 스레드 중간에서 멘션되면 새 스레드를 만들어 작업한다. 현재는 원본 스레드의 모든 봇 메시지를 삭제하여 참여자들이 봇의 존재와 작업 위치를 알 수 없게 된다.

이 피처는 세 가지를 해결한다:
1. **초기 메시지 유지**: mid-thread 멘션 시 원본 스레드에 의도 요약 + 새 스레드 링크를 남긴다
2. **원본 스레드 추적**: 세션에 `sourceThread` 정보를 저장하여 원본 ↔ 작업 스레드 양방향 연결
3. **완료 시 요약 게시**: PR 머지 또는 세션 종료 시 원본 스레드에 작업 결과 executive summary를 게시

## 2. User Stories

- As a 스레드 참여자, I want 봇의 초기 응답이 원래 스레드에 남아있기를, so that 봇이 요청을 받았다는 사실과 작업 위치를 알 수 있다
- As a 봇 멘션 요청자, I want 새 스레드 링크가 초기 메시지에 포함되기를, so that 클릭 한 번으로 작업 진행 상황을 추적할 수 있다
- As a 원본 스레드 참여자, I want 작업이 완료되면 원본 스레드에 요약이 자동 게시되기를, so that 스레드를 벗어나지 않고도 결과를 확인할 수 있다
- As a 원본 스레드 참여자, I want 원본 스레드에서 봇을 재멘션하면 작업 상태/결과를 응답받기를, so that 완료 여부를 즉시 파악할 수 있다

## 3. Acceptance Criteria

- [ ] mid-thread 멘션 시 원본 스레드의 봇 초기 메시지가 삭제되지 않는다
- [ ] 초기 메시지에 의도 요약 + 새 스레드 permalink가 포함된다
- [ ] DM/채널 최상위 멘션에서는 기존 동작(메시지 삭제) 유지
- [ ] mid-thread로 생성된 세션의 `ConversationSession`에 `sourceThread` 정보가 저장된다
- [ ] PR 머지 시 원본 스레드에 작업 결과 요약이 자동 게시된다
- [ ] 세션 종료(close) 시 원본 스레드에 작업 결과 요약이 자동 게시된다
- [ ] 원본 스레드에서 봇 재멘션 시 연결된 세션의 작업 상태/결과를 응답한다

## 4. Scope

### In-Scope
- `createBotInitiatedThread()`에서 mid-thread 조건 분기 + 초기 메시지 유지
- `ConversationSession`에 `sourceThread` 필드 추가
- PR 머지 시 원본 스레드에 요약 게시 (action-panel-action-handler)
- 세션 종료 시 원본 스레드에 요약 게시 (session-action-handler)
- 원본 스레드 재멘션 시 연결된 세션 조회 + 상태 응답 (event-router)

### Out-of-Scope
- AI 기반 정교한 요약 생성 (1차 구현은 구조화된 정적 요약)
- 원본 스레드의 대화 내용을 새 세션에 자동 주입
- DM에서의 동작 변경

## 5. Architecture

### 5.1 Layer Structure

```
[Scenario 1: 초기 메시지 유지]
EventRouter → SlackHandler.handleMessage()
  → SessionInitializer.initialize()
    → createBotInitiatedThread(isMidThread)
      → postMessage (유지) + getPermalink (새 스레드)
      → deleteThreadBotMessages 스킵 (isMidThread)

[Scenario 2: sourceThread 저장]
createBotInitiatedThread()
  → botSession.sourceThread = { channel, threadTs }

[Scenario 3: PR 머지 시 요약]
ActionPanelActionHandler (pr_merge action)
  → mergeGitHubPR()
  → session.sourceThread 존재 시
    → postSourceThreadSummary(session)

[Scenario 4: 세션 종료 시 요약]
SessionActionHandler (close_session_confirm)
  → session.sourceThread 존재 시
    → postSourceThreadSummary(session)
  → terminateSession()

[Scenario 5: 원본 스레드 재멘션]
EventRouter (app_mention in thread)
  → findLinkedSession(channel, threadTs)
  → 연결된 세션 있으면 → 상태/결과 응답
```

### 5.2 Data Model 변경

```typescript
// types.ts — ConversationSession에 추가
sourceThread?: {
  channel: string;    // 원본 스레드 채널 ID
  threadTs: string;   // 원본 스레드 ts
};
```

### 5.3 Integration Points

| 기존 코드 | 역할 | 변경 여부 |
|-----------|------|----------|
| `types.ts:ConversationSession` | 세션 타입 정의 | **변경** — `sourceThread` 필드 추가 |
| `session-initializer.ts:createBotInitiatedThread()` | 봇 스레드 생성 | **변경** — mid-thread 분기 + sourceThread 저장 |
| `session-initializer.ts:initialize()` | 세션 초기화 | **변경** — isMidThread 판별 + 전달 |
| `action-panel-action-handler.ts` | PR 머지 처리 | **변경** — 머지 후 sourceThread에 요약 게시 |
| `session-action-handler.ts` | 세션 종료 처리 | **변경** — 종료 전 sourceThread에 요약 게시 |
| `event-router.ts` | 이벤트 라우팅 | **변경** — 원본 스레드 재멘션 시 연결 세션 조회 |
| `session-registry.ts` | 세션 저장/조회 | **변경** — sourceThread 기반 역방향 조회 메서드 |
| `slack-api-helper.ts:getPermalink()` | permalink 생성 | 기존 그대로 사용 |

## 6. Non-Functional Requirements

- **Performance**: 요약 게시는 비동기 fire-and-forget. 머지/종료 응답 지연 없음
- **Security**: sourceThread 접근 시 채널 권한 확인 불필요 (봇이 이미 해당 채널에 있음)
- **Persistence**: sourceThread는 세션과 함께 저장/복원됨 (session-registry 기존 직렬화 활용)

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| mid-thread 판별: `event.thread_ts !== undefined` | tiny (~2 lines) | Slack 표준 필드. thread_ts 존재 = reply |
| `createBotInitiatedThread`에 `isMidThread: boolean` 파라미터 추가 | small (~10 lines) | 함수 시그니처 + 호출부 2곳 수정 |
| `sourceThread` 필드를 `ConversationSession`에 직접 추가 | small (~5 lines) | `routeContext`는 transient — 세션에 영구 저장 필요 |
| 요약 게시 함수를 별도 유틸로 분리 (`postSourceThreadSummary`) | small (~15 lines) | PR 머지/세션 종료 두 곳에서 공유 |
| 역방향 조회: `findSessionBySourceThread(channel, threadTs)` | small (~10 lines) | session-registry에 추가. 전체 세션 순회 — 세션 수 < 100이므로 성능 무관 |
| 요약 포맷: 구조화된 텍스트 (Slack mrkdwn) | tiny (~5 lines) | AI 요약은 Out-of-Scope. 정적 구조 + 세션 메타데이터로 충분 |

## 8. Open Questions

None — 이슈 TO-BE가 구체적이며, 모든 결정이 small 이하 tier.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/mid-thread-initial-response/spec.md`
