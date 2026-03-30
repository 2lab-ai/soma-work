# Auto-Resume Interrupted Sessions — Vertical Trace

> STV Trace | Created: 2026-03-26
> Spec: docs/auto-resume/spec.md

## Table of Contents
1. [S1 — Working session auto-resumes after restart](#s1)
2. [S2 — Waiting session gets notification only](#s2)
3. [S3 — Auto-resume failure is isolated](#s3)
4. [S4 — Multiple sessions resume sequentially with delay](#s4)

---

## S1 — Working session auto-resumes after restart {#s1}

### 1. Entry Point
- Method: `SlackHandler.notifyCrashRecovery()`
- Trigger: Called from `index.ts` after `app.start()` completes
- Pre-condition: `loadSessions()` has populated `_crashRecoveredSessions[]`

### 2. Input
- CrashRecoveredSession:
  ```typescript
  {
    channelId: "C123",
    threadTs: "1700000000.000100",
    ownerId: "U456",
    ownerName: "Zhuge",
    activityState: "working",
    sessionKey: "C123-1700000000.000100"  // NEW field
  }
  ```
- Resume prompt (constant):
  ```
  "slack-thread → get_thread_messages 이거로 유저의 마지막 명령까지 대화를 확인하고 네가 한 작업일 이어서 진행해줘"
  ```

### 3. Layer Flow

#### 3a. session-registry.ts — loadSessions() (수집)
- `serialized.activityState !== 'idle'` 조건 분기
- 기존: `{ channelId, threadTs, ownerId, ownerName, activityState }` push
- 변경: `sessionKey` 추가 — `serialized.key` 값 사용
- Transformation: `serialized.key` → `CrashRecoveredSession.sessionKey`
- File: `src/session-registry.ts:1210-1218`

#### 3b. slack-handler.ts — notifyCrashRecovery() (분기+실행)
- 기존 로직: 모든 recovered 세션에 알림 메시지 전송
- 신규 분기: `session.activityState === 'working'` 체크
  - true → 알림 전송 후 `autoResumeSession(session)` 호출
  - false → 알림만 전송 (기존 동작)
- File: `src/slack-handler.ts:585-610`

#### 3c. slack-handler.ts — autoResumeSession() (신규 private method)
- Synthetic MessageEvent 생성:
  ```typescript
  {
    user: session.ownerId,           // CrashRecoveredSession.ownerId → MessageEvent.user
    channel: session.channelId,      // CrashRecoveredSession.channelId → MessageEvent.channel
    thread_ts: session.threadTs,     // CrashRecoveredSession.threadTs → MessageEvent.thread_ts
    ts: Date.now().toString(),       // 현재 시각으로 생성
    text: RESUME_PROMPT,             // 고정 프롬프트 문자열
  }
  ```
- noopSay 생성: `async () => ({ ts: undefined })`
- `this.handleMessage(syntheticEvent, noopSay)` 호출
- Transformation chain:
  ```
  CrashRecoveredSession.ownerId → MessageEvent.user → session lookup by ownerId
  CrashRecoveredSession.channelId → MessageEvent.channel → pipeline routing
  CrashRecoveredSession.threadTs → MessageEvent.thread_ts → session key derivation
  RESUME_PROMPT → MessageEvent.text → prompt sent to Claude Agent SDK
  ```

#### 3d. handleMessage() → 기존 파이프라인 (변경 없음)
- `InputProcessor.processFiles()` → no files, continues
- `InputProcessor.routeCommand()` → not a command, continues
- `SessionInitializer.initialize()` → finds existing session by channel+threadTs
- `StreamExecutor.execute()` → `session.sessionId` exists → `options.resume = session.sessionId`
- Claude Agent SDK receives prompt + resume → restores context, continues work

### 4. Side Effects
- Slack message: 알림 메시지 (기존) + eyes reaction on synthetic ts
- Claude Agent SDK: resume session with prompt
- Session state: `activityState` transitions `idle → working` via pipeline

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| Slack notification post fails | API error | Log warning, continue to next session |
| handleMessage throws | Any error | try/catch in autoResumeSession, log error, do NOT rethrow |
| Session not found in pipeline | SessionInitializer returns early | Pipeline completes without action, no crash |
| Claude Agent SDK resume fails | SDK error | Handled by StreamExecutor's existing error handling |

### 6. Output
- 알림 메시지: `"⚠️ 서비스가 재시작되었습니다. 이전 작업(working)이 중단되었을 수 있습니다. 자동으로 재개합니다..."`
- Auto-resume: 모델이 get_thread_messages로 컨텍스트 확인 후 작업 이어감

### 7. Observability
- Log: `'Auto-resuming working session'` with `{ channelId, threadTs, ownerId }`
- Log: `'Auto-resume completed'` or `'Auto-resume failed'` with error details
- Log: `'Sent crash recovery notifications to N/M sessions, auto-resumed K'`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `notifyCrashRecovery_calls_handleMessage_for_working_sessions` | Happy Path | S1, Section 3b-3c |
| `autoResumeSession_creates_correct_synthetic_event` | Contract | S1, Section 3c transformation chain |
| `auto_resume_notification_message_differs_from_manual` | Contract | S1, Section 6 |

---

## S2 — Waiting session gets notification only {#s2}

### 1. Entry Point
- Same as S1

### 2. Input
- CrashRecoveredSession with `activityState: "waiting"`

### 3. Layer Flow

#### 3a. slack-handler.ts — notifyCrashRecovery()
- `session.activityState === 'working'` → false
- Posts existing notification: `"⚠️ 서비스가 재시작되었습니다. 이전 작업(waiting)이 중단되었을 수 있습니다. 다시 시도해주세요."`
- Does NOT call `autoResumeSession()`

### 4. Side Effects
- Slack message: 기존 알림만 (변경 없음)
- NO Claude Agent SDK call

### 5. Error Paths
- Same as existing error handling (notification failure logged)

### 6. Output
- 기존 알림 메시지만 전송

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `notifyCrashRecovery_does_not_auto_resume_waiting_sessions` | Sad Path | S2, Section 3a |

---

## S3 — Auto-resume failure is isolated {#s3}

### 1. Entry Point
- Same as S1, but `handleMessage` throws during auto-resume

### 2. Input
- CrashRecoveredSession with `activityState: "working"`
- handleMessage throws `Error('SDK connection failed')`

### 3. Layer Flow

#### 3a. slack-handler.ts — autoResumeSession()
- try/catch wraps `this.handleMessage(syntheticEvent, noopSay)`
- catch block: `this.logger.error('Auto-resume failed', { error, channelId, threadTs })`
- Does NOT rethrow — returns gracefully

#### 3b. slack-handler.ts — notifyCrashRecovery()
- Continues to next session in loop
- Final count reflects: `auto-resumed: K-1` (one failure)

### 4. Side Effects
- Failed session: notification sent, auto-resume failed, logged
- Other sessions: unaffected

### 5. Error Paths
| Condition | Handling |
|-----------|----------|
| handleMessage throws | Caught, logged, continue loop |
| eyes reaction fails (synthetic ts) | Non-critical, caught by slackApi |

### 6. Output
- Error logged but server continues normally

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `autoResumeSession_catches_handleMessage_errors` | Sad Path | S3, Section 3a |
| `notifyCrashRecovery_continues_after_resume_failure` | Sad Path | S3, Section 3b |

---

## S4 — Multiple sessions resume sequentially with delay {#s4}

### 1. Entry Point
- Same as S1, with 3 crashed sessions: 2 working + 1 waiting

### 2. Input
```typescript
[
  { activityState: "working", channelId: "C1", threadTs: "t1", ... },
  { activityState: "waiting", channelId: "C2", threadTs: "t2", ... },
  { activityState: "working", channelId: "C3", threadTs: "t3", ... },
]
```

### 3. Layer Flow

#### 3a. notifyCrashRecovery() sequential loop
1. Session C1 (working): notify → delay(2000) → autoResumeSession
2. Session C2 (waiting): notify only → delay(2000)
3. Session C3 (working): notify → delay(2000) → autoResumeSession

- Delay: `await new Promise(resolve => setTimeout(resolve, 2000))` between sessions
- Total time: ~6 seconds for 3 sessions

### 4. Side Effects
- 3 notification messages sent
- 2 auto-resume calls (C1 and C3)
- ~2 second gap between each session processing

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `notifyCrashRecovery_processes_sessions_with_delay` | Side-Effect | S4, Section 3a |
| `notifyCrashRecovery_resumes_only_working_sessions_in_batch` | Contract | S4, Section 3a |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| noopSay returns `{ ts: undefined }` | tiny (~5) | handleMessage expects say function but auto-resume doesn't need Slack response routing. `wrappedSay` in handleMessage only uses `result.ts`. |
| 알림 메시지 텍스트 분기: working → "자동으로 재개합니다..." / others → "다시 시도해주세요" | tiny (~5) | 유저에게 어떤 세션이 자동 재개되는지 명확히 전달. |
| Delay는 notification 후, auto-resume 전이 아니라 세션 간에 적용 | tiny (~5) | 각 세션의 notify+resume를 원자적으로 처리하고, 다음 세션까지 쉬는 구조가 단순함. |
| RESUME_PROMPT를 상수로 정의 | tiny (~5) | 나중에 변경 시 한 곳만 수정. |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| S1. Working session auto-resumes | done | RED | Ready for stv:work |
| S2. Waiting session notification only | done | RED | Ready for stv:work |
| S3. Auto-resume failure isolation | done | RED | Ready for stv:work |
| S4. Multiple sessions with delay | done | RED | Ready for stv:work |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work`
