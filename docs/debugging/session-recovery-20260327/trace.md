# Bug Trace: Session Recovery Failure — 서버 재시작 후 세션 복구 100% 실패

## AS-IS
서버 재시작 후 auto-resume 시 `No conversation found with session ID: xxx` 에러가 100% 발생.
세션 복구가 완전히 불가능하여 유저가 새 세션을 시작해야 함.

## TO-BE
서버 재시작 후 working 상태였던 세션이 정상적으로 auto-resume되어야 함.
이전 Claude SDK conversation은 프로세스 재시작으로 소멸하므로, 새 conversation으로 시작하되 Slack 스레드 맥락을 활용해 이어가야 함.

---

## Phase 1: Heuristic Top-3

### Hypothesis 1: loadSessions()가 stale sessionId를 복원하여 resume 시도 ✅ **ROOT CAUSE**

**흐름 추적:**

```
1. 서버 종료 시:
   index.ts:243        → slackHandler.saveSessions()
   claude-handler.ts:246 → sessionRegistry.saveSessions()
   session-registry.ts:1103 → saveSessions() — sessionId 포함하여 파일에 직렬화

2. 서버 재시작 시:
   index.ts:139        → slackHandler.loadSavedSessions()
   slack-handler.ts:650 → claudeHandler.loadSessions()
   session-registry.ts:1157 → loadSessions()
   session-registry.ts:1202 → session.sessionId = serialized.sessionId  ← stale ID 복원!

3. auto-resume 실행:
   slack-handler.ts:664 → notifyCrashRecovery()
   slack-handler.ts:711 → autoResumeSession(session, notificationTs)
   slack-handler.ts:761 → handleMessage(syntheticEvent, noopSay)
   → pipeline → claudeHandler.query()

4. Claude SDK 호출:
   claude-handler.ts:555 → if (session?.sessionId) {
   claude-handler.ts:556 →   options.resume = session.sessionId;  ← stale ID로 resume 시도
   claude-handler.ts:557 → }

5. 에러:
   Claude SDK → "No conversation found with session ID: b9242508-..."
```

**판정:**
- Claude SDK의 conversation은 **프로세스 in-memory** 상태다.
- 서버 재시작 = 프로세스 종료 = 모든 conversation 소멸.
- `loadSessions()`가 소멸된 conversation의 sessionId를 복원하여 resume 시도.
- **sessionId가 있으면 무조건 resume** 경로로 진입하므로 100% 실패.

### Hypothesis 2: auto-resume prompt가 잘못됨 ❌ Ruled out
- `AUTO_RESUME_PROMPT`는 스레드 맥락을 읽으라는 지시. prompt 자체는 문제없음.
- 문제는 Claude SDK에 도달하기 전에 stale sessionId로 resume하는 것.

### Hypothesis 3: crash-recovered 세션의 activityState 오류 ❌ Ruled out
- `loadSessions()`에서 `activityState: 'idle'`로 초기화(line 1214).
- `_crashRecoveredSessions`에는 원본 `serialized.activityState` 사용(line 1245).
- activityState 로직은 정상.

---

## Conclusion

**Root Cause: `session-registry.ts:1202`에서 `sessionId`를 파일에서 복원하지만,
Claude SDK conversation은 프로세스 재시작 시 소멸하므로 stale ID가 됨.
`claude-handler.ts:555`에서 이 stale ID로 resume을 시도하여 100% 실패.**

## Fix Strategy

**Option A (최소 변경, 추천)**: `loadSessions()`에서 `sessionId`를 복원하지 않음.
서버 재시작 후에는 항상 새 Claude conversation으로 시작.
Slack 스레드 컨텍스트는 `get_thread_messages`로 복원 가능.

```typescript
// session-registry.ts loadSessions()
const session: ConversationSession = {
  ...
  sessionId: undefined,  // 변경: serialized.sessionId → undefined
  ...
};
```

**Option B**: `claudeHandler.query()`에서 resume 실패 시 fallback으로 새 conversation 시작.
더 복잡하고 에러 핸들링 경로가 늘어남.

**추천: Option A** — 1줄 변경으로 근본 원인 제거.
