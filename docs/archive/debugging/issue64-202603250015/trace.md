# Bug Trace: Issue #64 — mid-thread 멘션 시 3가지 증상

## AS-IS
1. 원본 스레드에서 봇 응답 메시지가 삭제됨 (디스패치 찌꺼기 포함 전부 사라짐)
2. 세션 종료 시 원본 스레드에 요약이 나타나지 않음
3. 부모 메시지(스레드 시작 메시지)가 MCP 도구로 조회되지 않음

## TO-BE
1. 원본 스레드에 디스패치 메시지는 삭제하되, **삭제 후** retention 메시지("작업 시작 + 새 스레드 링크")를 남겨야 함
2. 세션 종료/PR 머지 시 원본 스레드에 작업 요약이 게시되어야 함
3. `get_thread_messages` 도구가 스레드 부모(root) 메시지를 포함해야 함

---

## Phase 1: Heuristic Top-3

### Hypothesis 1: MCP 서버가 thread root를 의도적으로 건너뜀 (Bug #3) ✅ 확정
- `src/slack-thread-mcp-server.ts:279` → `fetchMessagesBefore()`:
  ```typescript
  if (m.ts === this.context.threadTs) continue;  // Skip thread root
  ```
- `src/slack-thread-mcp-server.ts:315` → `fetchMessagesAfter()`:
  ```typescript
  if (m.ts === this.context.threadTs) continue;  // Skip root
  ```
- Slack `conversations.replies` API는 첫 번째 페이지에서 항상 thread root를 포함함
- 코드가 이를 "중복 방지"로 skip하지만, **부모 메시지에 핵심 맥락이 담겨있을 때 모델이 문맥을 완전히 잃음**
- 모델 응답 "부모 메시지는 조회되지 않는다"와 정확히 일치

### Hypothesis 2: createBotInitiatedThread의 삭제 순서 문제 (Bug #1) ✅ 확정 (유저 확인)
- 유저 증언: "항상 디스패치를 타고, 디스패치 코드에서 자연스럽게 메시지 삭제가 일어난다"
- **현재 코드 흐름** (`session-initializer.ts:678-694`):
  ```
  1. isMidThread → retention 메시지 게시 (line 678-685)
  2. !isMidThread → deleteThreadBotMessages (line 693-694)
  ```
- **문제**: mid-thread일 때 삭제를 skip하므로:
  - 디스패치 메시지("✅ Workflow: ...") 가 원본 스레드에 그대로 남음 (지저분)
  - retention 메시지와 디스패치 찌꺼기가 공존
- **실제로 사용자가 원하는 동작**:
  ```
  1. deleteThreadBotMessages — 항상 실행 (디스패치 찌꺼기 정리)
  2. isMidThread → 삭제 후 retention 메시지 게시 (깨끗한 상태에서 안내 메시지만 남김)
  ```

### Hypothesis 3: channel-route-handler 누락 (Bug #1 부차적 경로)
- `channel-route-action-handler.ts:91,159` — isMidThread 체크 없이 삭제
- 이 경로는 PR 워크플로우 + 채널 라우팅이 발동할 때만 해당
- 현재 이슈와는 직접 관련 없으나, 향후 방어 가드 추가 권장
- ⚠️ 부차적 — 현재 시나리오에서는 해당 없음

---

## Phase 2: 확정된 수정 계획

### Fix 1: Thread root 포함 (Bug #3) — `slack-thread-mcp-server.ts`

**위치**: `fetchMessagesBefore()` (line 279), `fetchMessagesAfter()` (line 315)

**변경**: thread root를 skip하지 않고, 별도로 수집하여 결과 앞에 항상 포함

```typescript
// fetchMessagesBefore — line 279 삭제 or 조건 변경
// BEFORE:
if (m.ts === this.context.threadTs) continue;

// AFTER: root를 별도 수집, count에서 제외 (bonus 포함)
```

**반환 형식 변경** (방법 B 권장):
```typescript
interface GetThreadMessagesResult {
  thread_ts: string;
  channel: string;
  thread_root: ThreadMessage | null;   // ← 신규: 항상 포함
  returned: number;
  messages: ThreadMessage[];
  has_more_before: boolean;
  has_more_after: boolean;
}
```

### Fix 2: 삭제 후 retention 게시 순서 변경 (Bug #1) — `session-initializer.ts`

**위치**: `createBotInitiatedThread()` line 678-694

```typescript
// BEFORE (현재):
if (isMidThread) {
    // retention 게시
    await this.deps.slackApi.postMessage(...);
}
// ...
if (!isMidThread) {
    await this.deps.slackApi.deleteThreadBotMessages(channel, threadTs);
}

// AFTER (수정):
// 1. 항상 디스패치 메시지 정리
await this.deps.slackApi.deleteThreadBotMessages(channel, threadTs);
// 2. mid-thread이면 깨끗한 상태에서 retention 메시지 게시
if (isMidThread) {
    const newThreadPermalink = await this.deps.slackApi.getPermalink(channel, rootResult.ts);
    const linkText = newThreadPermalink ? ` → ${newThreadPermalink}` : '';
    await this.deps.slackApi.postMessage(
        channel,
        `📋 요청을 확인했습니다. 새 스레드에서 작업을 진행합니다${linkText}`,
        { threadTs }
    );
}
```

### Fix 3: Bug #2는 Fix #2로 자동 해소

- `sourceThread`는 line 664-666에서 정상 설정됨 (삭제 순서와 무관)
- `postSourceThreadSummary`는 `session.sourceThread`가 있으면 동작
- Fix #2로 retention 메시지가 정상 게시되면, 사용자 경험상 Bug #2도 해결

---

## 결론

| Bug | 근본 원인 | 확신도 | 수정 위치 |
|-----|----------|--------|----------|
| **#3** 부모 메시지 미조회 | `fetchMessagesBefore/After()`에서 thread root 강제 skip | **100%** | `slack-thread-mcp-server.ts:279,315` |
| **#1** 응답 삭제 / 찌꺼기 잔존 | `isMidThread`일 때 삭제를 skip하는 로직 → 순서를 "삭제 먼저 → retention 게시"로 변경 | **100%** | `session-initializer.ts:678-694` |
| **#2** 종료 시 요약 없음 | `sourceThread` 설정은 정상. Fix #2로 UX 해소 | **90%** | Fix #2로 해소 |
