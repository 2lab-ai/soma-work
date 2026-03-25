# Bug Trace: Auto-resume only works for 1 of 4 sessions

## AS-IS: 서버 재시작 후 4개 working 세션 중 1개만 auto-resume됨
## TO-BE: 모든 working 세션이 auto-resume 되어야 함

## Phase 1: Heuristic Top-3

### Hypothesis 1: Slack reaction on notification ts fails
- `slack-handler.ts:239` → `addReaction(channel, ts, 'eyes')` — ts는 notification 메시지의 실제 ts
- notification 메시지는 성공적으로 전송됨 (유저가 알림을 봤음)
- ❌ Ruled out — ts가 실제 Slack 메시지이므로 reaction은 성공해야 함

### Hypothesis 2: activityState가 'working'이 아닌 세션이 있었다
- 유저 증거: "테스트를 작성한다" 출력 후 재시작 → 확실히 working 상태
- MCP 세션: llm chat 호출 중 → 이것도 working 상태
- ⚠️ Possible but unlikely — 대부분 working이었을 것

### Hypothesis 3: `await handleMessage`가 blocking — 첫 세션 완료까지 나머지 대기 ★
- `slack-handler.ts:685` → `await this.handleMessage(syntheticEvent, noopSay)`
- `handleMessage` → L368 `streamExecutor.execute()` → Claude SDK 스트리밍
- 스트리밍은 수분~수십분 소요
- for 루프가 순차 실행이므로 첫 번째 working 세션의 스트리밍 완료까지 나머지 blocked
- `index.ts:171` → `notifyCrashRecovery().then(...)` — fire-and-forget이지만 내부는 sequential
- ✅ **ROOT CAUSE CONFIRMED**

## Call Stack

```
index.ts:171     notifyCrashRecovery().then(...)  // fire-and-forget
  slack-handler.ts:598  for (i=0; i<recovered.length; i++)  // sequential loop
    :609  chat.postMessage → notification ✅ (all 4)
    :637  await autoResumeSession(session[0]) // ⚠️ BLOCKS HERE
      :685  await handleMessage(syntheticEvent)  // BLOCKS for minutes
        :239  addReaction('eyes') ✅
        :368  await streamExecutor.execute()  // Claude SDK streaming - LONG RUNNING
          ... model works for 5-30 minutes ...
        :386  loop continues or breaks
      // returns after model finishes
    :654  delay(2000)
    :637  await autoResumeSession(session[1])  // finally processes, but timeout/context issues
    ...
```

## Conclusion

`autoResumeSession()`이 `await handleMessage()`를 사용하여 **동기적으로 blocking**된다.
첫 번째 working 세션의 Claude SDK 스트리밍이 완료될 때까지 (수분~수십분) 나머지 세션은
for 루프에서 대기 상태. 실질적으로 첫 번째 세션만 auto-resume 된다.

## Fix

`await this.handleMessage(...)` → `this.handleMessage(...).catch(...)` (fire-and-forget)
각 세션의 auto-resume를 비동기로 독립 실행하고, 루프는 notification만 순차 처리.
