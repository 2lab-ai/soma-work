# Mid-Thread 멘션 시 초기 응답 유지 + 원본 스레드 추적 — Vertical Trace

> STV Trace | Created: 2026-03-24 | Updated: 2026-03-24
> Spec: docs/mid-thread-initial-response/spec.md
> GitHub Issue: #64

## Table of Contents
1. [Scenario 1 — Mid-thread 멘션: 초기 메시지 유지 + 새 스레드 링크](#scenario-1)
2. [Scenario 2 — Top-level 멘션: 기존 동작 유지](#scenario-2)
3. [Scenario 3 — sourceThread 저장: 세션에 원본 스레드 참조 영구 보존](#scenario-3)
4. [Scenario 4 — PR 머지 시 원본 스레드에 요약 게시](#scenario-4)
5. [Scenario 5 — 세션 종료 시 원본 스레드에 요약 게시](#scenario-5)

---

## Scenario 1 — Mid-thread 멘션: 초기 메시지 유지 + 새 스레드 링크

### 1. Event Entry
- Event: Slack `app_mention` (reply in existing thread)
- Trigger: `event.thread_ts !== undefined`

### 2. Input
```json
{
  "user": "U_REQUESTER",
  "channel": "C_CHANNEL",
  "thread_ts": "1711234567.000100",
  "ts": "1711234599.000200",
  "text": "@zhugeliang 여기 내용 정리해줘"
}
```

### 3. Layer Flow

#### 3a. SessionInitializer.initialize() — `session-initializer.ts:77`
- `const isMidThread = thread_ts !== undefined` (line 83-84 부근)
- `isMidThread` → `createBotInitiatedThread()` 7번째 파라미터로 전달
- 호출부 2곳: line 357 (PR routing) + line 378 (non-PR)

#### 3b. createBotInitiatedThread() — `session-initializer.ts:617`
- 시그니처: `+ isMidThread: boolean` 파라미터 추가
- Line 670-675 변경:

```
[isMidThread = true]
  getPermalink(channel, rootResult.ts) → newThreadPermalink
  postMessage(channel, '📋 요청을 확인했습니다. 새 스레드에서 작업을 진행합니다 → {newThreadPermalink}', { threadTs })
  postMigratedContextSummary(channel, rootResult.ts, oldThreadPermalink, session)
  // deleteThreadBotMessages 호출하지 않음

[isMidThread = false]
  (기존 동작 그대로)
```

### 4. Side Effects
- **mid-thread**: postMessage 유지 (삭제 안 함) + permalink 포함
- **deleteThreadBotMessages 미호출**

### 5. Error Paths
| Condition | 처리 |
|-----------|------|
| `getPermalink()` null | 링크 없이 메시지 전송 (graceful) |

### 6. Output
원본 스레드: `📋 요청을 확인했습니다. 새 스레드에서 작업을 진행합니다 → https://...`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `midThread_doesNotDeleteBotMessages` | Side-Effect | S1, Sec 3b — deleteThreadBotMessages 미호출 |
| `midThread_includesNewThreadPermalink` | Contract | S1, Sec 3b — rootResult.ts → permalink → postMessage |
| `midThread_retainsInitialMessage` | Happy Path | S1, Sec 3b — 📋 메시지 게시 확인 |
| `midThread_permalinkNull_gracefulDegradation` | Sad Path | S1, Sec 5 — getPermalink null |

---

## Scenario 2 — Top-level 멘션: 기존 동작 유지

### 1. Event Entry
- Event: Slack `app_mention` (channel top-level)
- Trigger: `event.thread_ts === undefined`

### 3. Layer Flow
- `isMidThread = false` → 기존 경로: postMessage + deleteThreadBotMessages

### Contract Tests (GREEN — 이미 통과)
| Test Name | Category |
|-----------|----------|
| `topLevel_deletesBotMessages` | Happy Path |
| `topLevel_doesNotRetainInitialMessage` | Side-Effect |

---

## Scenario 3 — sourceThread 저장: 세션에 원본 스레드 참조 영구 보존

### 1. Event Entry
- 동일: mid-thread 멘션으로 `createBotInitiatedThread` 진입

### 3. Layer Flow

#### 3a. types.ts — ConversationSession 타입 확장
- 파일: `src/types.ts:257` (ConversationSession 인터페이스 끝 부근)
- 추가:
```typescript
sourceThread?: {
  channel: string;
  threadTs: string;
};
```

#### 3b. createBotInitiatedThread() — `session-initializer.ts:649-658`
- `botSession` 필드 설정 블록에 추가:
```
isMidThread = true일 때:
  botSession.sourceThread = { channel, threadTs }
  // channel = 원본 채널, threadTs = 원본 스레드 ts (함수 파라미터)
```

#### 3c. session-registry.ts — 역방향 조회 메서드
- `findSessionBySourceThread(channel: string, threadTs: string): ConversationSession | undefined`
- 전체 세션 Map 순회하여 `session.sourceThread.channel === channel && session.sourceThread.threadTs === threadTs` 매칭

### 4. Side Effects
- 세션 직렬화 시 `sourceThread` 필드 포함 (기존 session save/load 자동 처리)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `midThread_savesSourceThread` | Happy Path | S3, Sec 3b — sourceThread 저장 |
| `topLevel_noSourceThread` | Contract | S3, Sec 3b — isMidThread=false일 때 sourceThread 없음 |
| `findSessionBySourceThread_returnsLinkedSession` | Happy Path | S3, Sec 3c — 역방향 조회 |

---

## Scenario 4 — PR 머지 시 원본 스레드에 요약 게시

### 1. Event Entry
- Event: Slack button action `pr_merge`
- Handler: `ActionPanelActionHandler.handleMerge()` — `action-panel-action-handler.ts:276`

### 3. Layer Flow

#### 3a. ActionPanelActionHandler.handleMerge() — line 278-306
- 기존 flow 끝 (line 298, PR 머지 성공 후):
```
if (result.success && session.sourceThread) {
  await postSourceThreadSummary(this.ctx.slackApi, session, 'merged')
}
```

#### 3b. postSourceThreadSummary() — 신규 유틸 함수
- 파일: `src/slack/source-thread-summary.ts` (신규)
- Input: `slackApi`, `session`, `trigger: 'merged' | 'closed'`
- 출력 포맷:
```
✅ *"{session.title}"* 작업 완료

📌 *이슈*: {session.links.issue.url}
🔀 *PR*: {session.links.pr.url} — merged
📊 *워크플로우*: {session.workflow}
🧵 *작업 스레드*: {permalink to session thread}
```
- Transformation:
  - `session.sourceThread.channel` → postMessage channel
  - `session.sourceThread.threadTs` → postMessage threadTs
  - `session.title` → 요약 제목
  - `session.links` → 이슈/PR 링크
  - `session.workflow` → 워크플로우 유형

### 4. Side Effects
- Slack postMessage → 원본 스레드에 요약 게시

### 5. Error Paths
| Condition | 처리 |
|-----------|------|
| `sourceThread` 없음 | 스킵 (non-mid-thread 세션) |
| postMessage 실패 | 로깅 + 무시 (fire-and-forget) |
| `session.links` 일부 null | 해당 줄 생략 |

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `prMerge_postsSourceThreadSummary` | Happy Path | S4, Sec 3a — sourceThread 있는 세션 머지 |
| `prMerge_noSourceThread_skips` | Sad Path | S4, Sec 5 — sourceThread 없으면 스킵 |
| `postSourceThreadSummary_includesLinks` | Contract | S4, Sec 3b — 링크 포함 확인 |
| `postSourceThreadSummary_postFailure_noThrow` | Sad Path | S4, Sec 5 — postMessage 실패 시 throw 안 함 |

---

## Scenario 5 — 세션 종료 시 원본 스레드에 요약 게시

### 1. Event Entry
- Event: Slack button action `close_session_confirm`
- Handler: `SessionActionHandler.handleCloseConfirm()` — `session-action-handler.ts:43`

### 3. Layer Flow

#### 3a. SessionActionHandler.handleCloseConfirm() — line 58-69
- **기존** line 59-60 (zzz emoji) 이후, line 69 (terminateSession) 이전에 삽입:
```
if (session.sourceThread) {
  await postSourceThreadSummary(this.ctx.slackApi, session, 'closed')
}
```
- 동일한 `postSourceThreadSummary` 유틸 함수 재사용 (Scenario 4와 공유)

### 4. Side Effects
- Slack postMessage → 원본 스레드에 종료 요약 게시

### 5. Error Paths
- Scenario 4와 동일 (sourceThread 없음 → 스킵, postMessage 실패 → 로깅)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `sessionClose_postsSourceThreadSummary` | Happy Path | S5, Sec 3a — sourceThread 있는 세션 종료 |
| `sessionClose_noSourceThread_skips` | Sad Path | S5, Sec 5 — sourceThread 없으면 스킵 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| `sourceThread` 필드를 `ConversationSession`에 직접 추가 | small (~5 lines) | `routeContext`는 transient — 세션에 영구 저장 필요 |
| `postSourceThreadSummary`를 별도 파일로 분리 | small (~20 lines) | 두 handler에서 공유. 테스트 용이성 확보 |
| 역방향 조회 `findSessionBySourceThread`는 전체 순회 | tiny (~5 lines) | 세션 수 < 100. 인덱스 과잉 |
| 요약 포맷은 Slack mrkdwn 정적 구조 | tiny (~10 lines) | AI 요약은 Out-of-Scope |
| 요약 게시는 fire-and-forget (비동기, 에러 무시) | tiny (~2 lines) | 머지/종료의 핵심 경로를 차단하면 안 됨 |

## Implementation Status

| Scenario | Trace | Tests | Size | Status |
|----------|-------|-------|------|--------|
| 1. Mid-thread: 초기 메시지 유지 + 링크 | done | GREEN | small (~15 lines) | Complete |
| 2. Top-level: 기존 동작 유지 | done | GREEN | tiny (~0 lines) | Complete |
| 3. sourceThread 저장 | done | GREEN | small (~15 lines) | Complete |
| 4. PR 머지 시 원본 스레드 요약 | done | GREEN | small (~20 lines) | Complete |
| 5. 세션 종료 시 원본 스레드 요약 | done | GREEN | tiny (~5 lines) | Complete |

**총 구현량**: medium ~55 lines (5개 파일)

## Next Step

→ Proceed with implementation via `stv:do-work docs/mid-thread-initial-response/trace.md`
