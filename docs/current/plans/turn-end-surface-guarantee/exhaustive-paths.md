# Turn-end Surface Guarantee — Exhaustive Path Audit

**대상 커밋**: soma-work `main` HEAD (PR #926 머지 직후, ~`bfb6b5f`)
**작성자**: Z + Zhuge, 2026-05-26
**목적**: stream-stall-watchdog(PR #926) 삭제의 전제 조건. "유저 메시지 → 봇 응답" 한 cycle("turn")이 종료될 수 있는 **모든 코드 경로**를 콜스택 단위로 열거하고, 각 경로가 유저에게 visible terminal signal(🟢 / 🟠 / 🔴 Slack 카드 또는 동등한 텍스트)을 보장하는지 검사. 누락된 경로(=구멍)를 제로로 만들면 10분 watchdog 같은 blunt fail-safe가 불필요해진다.

핵심 파일: `packages/slack/src/pipeline/stream-executor.ts` (4322 LOC), `packages/slack/src/turn-notifier.ts`, `packages/slack/src/request-coordinator.ts`.

라인 번호는 모두 위 커밋 기준. 인용한 콜스택은 `StreamExecutor.execute()` 호출부터의 실제 흐름.

---

## 0. 진입점 콜스택 — 모든 경로의 공통 prefix

```
[caller: SlackBolt → V1QueryAdapter → ClaudeHandler.processMessage]
└─ StreamExecutor.execute(params)                                 L652
   └─ (sync prelude: prompt prep, session lookup, slot routing)
   └─ await this.deps.threadPanel?.beginTurn(turnContext)         L785
   └─ <core try-block>                                            L786~L1764
      └─ user 정보 조회 / fast-fail 게이트                       L975~L989
      └─ reaction "thinking" + spinner                            L991~L998
      └─ new StreamStallWatchdog(...)                             L838~L843  ← 삭제 대상
      └─ StreamCallbacks { onSdkActivity, onToolUse, onToolResult, ... } 정의 L1054~L1450 근처
      └─ const streamResult = await processor.process(...)        L1482
         └─ <SDK iterator: assistant deltas, tool_use, tool_result, end_turn>
      └─ (streamResult 후처리: hasPendingChoice 판정 등)          L1490~L1665
      └─ const category = determineTurnCategory(...)              L1665 근처
      └─ enrichAndResolve()                                       L1676
         └─ .then(evt => turnNotifier.notify(evt))                L1685   ★ 카드 발사
         └─ .catch(err => handleEnrichmentFailure(...))           L1698
      └─ 후속 continuation 라우팅 (renew / onboarding / tool)     L1725~L1762
      └─ return { success: true, ... }                            L1764
   └─ <catch> handleError(error, ..., requestAborted, abortReason) L1765~L1837
   └─ <finally> stallWatchdog.clear() / status clear / cleanup    L1838~L1906
```

---

## A. 정상 종료 경로 (10개)

각 경로의 콜스택은 **§0 prefix 뒤** 분기점만 표시. **"카드 발사"**는 `turnNotifier.notify(...)`가 도달 가능한 분기를 의미.

**Scope 주의**: 본 audit은 `StreamExecutor.execute()` 진입 후의 경로만 다룬다. 그 이전 단계(slack-handler dispatch, 명령 처리)의 early-return은 별도 audit 대상이다. 식별된 pre-execute exits: `src/slack-handler.ts:459-464, 486-492, 514-518`; `src/slack/commands/compact-handler.ts:55-87`. 이들은 "Slack turn" 전체 lifecycle 관점에서 추가 검증 필요.

### A-1. 정상 `WorkflowComplete` (🟢)
```
processor.process → SDK end_turn → streamResult { aborted: false, hasPendingChoice: false }
  → determineTurnCategory({hasPendingChoice:false, isError:false}) = WorkflowComplete  [turn-notifier.ts L58~62]
  → enrichAndResolve().then(evt => turnNotifier.notify(evt))                            [stream-executor.ts L1676,1685]
  → return { success: true }                                                            [L1764]
```
- 카드: 🟢 작업 완료. **OK.**

### A-2. `UIUserAskQuestion` (🟠)
```
processor.process → SDK end_turn → hasPendingChoice=true (ASK rendered upstream at L3328 등)
  → determineTurnCategory(...) = UIUserAskQuestion
  → turnNotifier.notify(evt)                                                            [L1685]
  → return { success: true }
```
- 카드: 🟠 유저 입력 대기. **OK.**

### A-3. 실 SDK 에러 → `Exception` (🔴)
```
processor.process → SDK throws (network / max_turns / API 4xx 등)
  → catch (error)                                                                       [L1765]
  → handleError(error, ..., requestAborted=false, abortReason=undefined)                [L1925]
     → isAbort = false
     → shouldNotifyException = true                                                     [L1969]
     → turnNotifier.notify({category:'Exception', message:coalesceErrorMessage(error)}) [L1982~]
     → say({text: errorDetails})                                                        [L2199]
  → return { success: false, retryAfterMs?, handled }                                   [L1832]
```
- 카드: 🔴 오류 발생 + 텍스트 상세. **OK (이중 보장).**

### A-4. `supersede` abort — 정상 mid-turn 조타 (silent)
```
[부모 dispatcher: session-initializer.handleConcurrency]
   → requestCoordinator.abortSession(sessionKey, 'supersede')                           [request-coordinator.ts L136]
   → controller.abort('supersede')                                                      [L139]
abortController.signal.aborted=true → processor.process throws AbortError
  → catch → coerceAbortReason('supersede') = 'supersede'                                [L1776, L413]
  → handleError(..., abortReason='supersede')
     → isAbort=true, stallTimeoutAbort=false
     → shouldNotifyException = false                                                    [L1970]
  → say(errorDetails) skipped (else 분기 L2203)
  → reactionManager.updateReaction(cancelled)                                           [L2212]
```
- 카드: 없음. **의도된 침묵** (PR #924). **OK.**

### A-5. `supersede` abort — stalled turn displace (🔴)
```
session-initializer.handleConcurrency 가 lastActivityAt 기반으로 stall 판정
   → abortSession(sessionKey, 'stall-timeout')   ← 'supersede'가 아니라 'stall-timeout'으로 태깅
   → controller.abort('stall-timeout')
catch → coerceAbortReason('stall-timeout') = 'stall-timeout'
  → stallTimeoutAbort = true                                                            [L1968]
  → shouldNotifyException = true
  → turnNotifier.notify({category:'Exception', message:'이전 턴이 일정 시간 응답이 없어 중단되었습니다.'}) [L1979,1982]
```
- 카드: 🔴. **OK** (PR #924가 dispatcher-level에서 처리).

### A-6. `user-stop` / `session-close` (silent)
```
[caller: Stop button / Close button / `!` command]
   → requestCoordinator.abortSession(sessionKey, 'user-stop' | 'session-close')
   → controller.abort('user-stop' | 'session-close')
catch → coerceAbortReason(...) = 'user-stop' | 'session-close'
  → isAbort=true, stallTimeoutAbort=false → shouldNotifyException=false
  → reaction(cancelled)
```
- 카드: 없음. **의도된 침묵** (유저가 직접 끔). **OK.**

### A-7. `shutdown` abort (silent)
```
[caller: process SIGTERM / restart handler]
   → requestCoordinator.clearAll()                                                      [request-coordinator.ts L175~]
   → controller.abort('shutdown')                                                       [L177]
catch → abortReason='shutdown' → 같은 침묵 분기
```
- 카드: 없음. 별도 restart 알림이 #916에서 보장. **OK.**

### A-8. `1M-context-unavailable` (silent on 카드, 텍스트로 대체)
```
processor.process → 1M context unavailable signal (text pattern)
  → catch (error)
  → handleError → isOneMContextUnavailableError(error) = true                            [L2347]
     → shouldNotifyException = false                                                    [L1970]   (silent on card)
     → !isAbort branch → say(errorDetails)                                              [L2199]
```
- 카드: 없음, 텍스트만. **OK** (#661 transparent retry).

### A-9. enrichment 실패 → fallback notify
```
enrichAndResolve().catch(err => handleEnrichmentFailure(err, fallbackArgs, resolveSnapshot)) [L1698]
   → turnNotifier.notify(fallback, notifyOpts)                                          [L582]
   (category는 원래 결정된 것 그대로 유지 — WorkflowComplete | UIUserAskQuestion | Exception)
```
- 카드: 원래 카테고리 fallback. **OK** (PR #923).

### A-10. SDK `sdkResultError` (codex 검증으로 추가)
```
processor.process → StreamProcessor가 error_max_turns / error_during_execution / error_during_invocation 등
                    ResultMessage를 throw 없이 캡쳐                                     [stream-processor.ts L1194~1214]
  → streamResult.hasSdkError = true
  → stream-executor.ts에서 hasSdkError → category='Exception' 매핑                       [L1505~1510, 1588~1591]
  → say({text: 추가 오류 메시지})                                                        [L1546~1564]
  → enrichAndResolve().then(evt => turnNotifier.notify(evt))                            [L1676,1685]
```
- 카드: 🔴 오류 발생. **OK.** A-3과 구분되는 별개 경로(`throw` 없이 SDK 자체가 error result를 yield하는 케이스).

---

## B. 진짜 종료지만 카드 못 띄우는 구멍 (BUG, 6개)

### B-1. Ghost-session self-abort → untagged → silent ★최우선
```
[trigger: 다른 코드 경로에서 session.terminated=true 설정]
StreamCallbacks.onToolUse(toolUses, ctx)                                                 [L1061]
  if (session.terminated) { abortController.abort(); return; }                          [L1063~1065]
                            ^^^^^^^^^^^^^^^^^^^^^^^
                            reason 없음 → signal.reason = DOMException("aborted") (modern Node)
                                                          (코드 주석 L1773~1775가 이걸 명시)
processor.process throws AbortError → catch
  → coerceAbortReason(DOMException → typeof !== 'string') = undefined                    [L413~415]
  → handleError(..., abortReason=undefined)
  → isAbort=true (isAbortLikeError), stallTimeoutAbort=false
  → shouldNotifyException=false   ★ 카드 안 나감
  → else 분기: reaction(cancelled)만 찍힘                                                [L2212]
```
- 동일 패턴: `onToolResult` L1126.
- 유저 입장: turn이 사라짐, 어떤 카드도 텍스트도 없음. **BUG.**
- 메커니즘 정정 (codex): `signal.reason`은 `undefined`가 아니라 DOMException. 그러나 `coerceAbortReason`이 non-string을 `undefined`로 변환하므로 효과는 동일.

### B-2. 외부에서 `controller.abort()` reason 없이 호출 → silent
```
[trigger: 미래의 추가 코드 / 서드파티 / DOM AbortController.abort() 기본 호출]
signal.reason = undefined (또는 DOMException)
→ coerceAbortReason → undefined → B-1과 동일 silent 분기
```
- 현재 grep 상 발견된 명시 호출은 B-1의 2곳뿐. 그러나 `coerceAbortReason`의 fallback이 `undefined` (silent)로 떨어지는 **정책 자체가 구멍**. unknown reason은 silent가 아니라 새 카테고리(예: `'unknown-abort'`)로 카드를 띄워야 한다.

### B-3. `TurnNotifier` zero-enabled-channels → 무신호
```
turnNotifier.notify(event) [stream-executor.ts L1685, L1982 등 모든 발사 지점]
  → TurnNotifier.notify(event)                                                          [turn-notifier.ts L198]
  → 모든 channel.isEnabled(userId) Promise.all                                          [L204~217]
  → active = enabledChannels.filter(...)                                                 [L219]
  → if (active.length === 0) return;                                                    [L221]   ★ warn조차 없음
```
- 유저 알림 채널 설정이 비어있거나 isEnabled가 모두 false면 turn-end가 완전 무신호.
- **BUG (turn-notifier.ts 단의 fail-silent)**.

### B-4. `this.deps.turnNotifier` DI 누락 → 무신호
```
shouldNotifyException 게이트                                                            [L1969]
  → !!this.deps.turnNotifier && ...
```
- DI 컨테이너에서 `turnNotifier` 미주입 시 abort/error 분기 모두 fallback 없음. `!isAbort`면 `say(errorDetails)` 텍스트가 남지만 abort면 reaction만.
- 테스트/harness/misconfig 시나리오. **BUG (deps optionality + abort fallback 부재).**

### B-5. 이메일 미설정 fast-fail (L982~989)
```
const resolvedEmail = userSettingsStore.getUserEmail(user);
if (!resolvedEmail) {
  await say({text: '⚠️ 이메일이 설정되지 않았습니다...'});                              [L983]
  return { success: false, messageCount: 0 };                                            [L988]
}
```
- 평문 ⚠️ 메시지만, Block Kit 카드 아님. 카테고리 표에 없음. 유저 입장에서는 turn 끝났는데 일관성 없는 신호.
- **BUG (카드 통일성).**

### B-6. Renew 실패 분기 → 카테고리 거짓말
```
enrichAndResolve.then(evt => turnNotifier.notify(evt))                                  [L1685]
   ★ 이 시점 category = 'WorkflowComplete' (성공으로 판정됨)
   ★ 🟢 카드 이미 발사됨
이후:
if (session.renewState === 'pending_save') {
  const continuation = await buildRenewContinuation(...);                                [L1727]
     └─ 내부에서 7개 실패 분기 (L3938~L4068, 파일 없음 / 경로 외부 / 등)
     └─ 실패 시 ⚠️ 텍스트 post + return undefined
  if (continuation) { ... }                                                              [L1733]
  // continuation === undefined → 그냥 통과
}
return { success: true, ... };                                                          [L1764]
```
- 결과: 🟢 카드가 떴는데 실제로 renew는 실패. 카테고리 misclassification.
- **BUG (renew 실패는 `Exception`이어야 함).**

---

## C. 카테고리에 도달조차 못 하는 hang 경로 (구조적, 6개)

이 경로들은 코드가 `try`/`catch`/`finally` 어디에도 도달하지 못함. **이게 정확히 10분 watchdog이 paper over했던 것**. watchdog 없이 잡으려면 각 await에 명시적 timeout이 필요.

### C-1. ★ `await processor.process(...)` 영원 hang — **Phase 2에서 fix됨**
```
const streamResult = await processor.process(streamQuery(...), streamContext, ...);    [L1482]
```
- 시나리오: SDK iterator가 `yield`도 안 하고 `throw`도 안 하고 abort signal도 안 트립.
- 결과: `await` 영원. catch 도달 못 함. finally 도달 못 함. 카드 없음.
- **Phase 2 (PR #969 followup)**: `StreamProcessor.process`가 `for await`를 manual iterator + `Promise.race`로 교체. 각 `iterator.next()`를 (a) external abort signal, (b) `idleTimeoutMs` 타이머와 race. 타이머가 winner면 `onIdleTimeout` 콜백이 발화하고 (`stream-executor`가 이를 `abortController.abort('stall-timeout')`로 와이어), `aborted: true`를 즉시 리턴. 기존 `handleError` `notifyWorthyAbort` 게이트가 🔴 stall-timeout 카드를 띄움. SDK가 abort를 honor하지 않아도 `await`가 풀린다는 것이 핵심. (`packages/slack/src/stream-processor.ts` `raceNextStep`, `readIdleTimeoutMs`, `DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000`.) PR #926 외부 `StreamStallWatchdog`는 Phase 2에서 삭제됨 — 같은 abort 신호를 만들어도 hung `.next()` 자체를 풀지 못해서 효과가 없었음.

### C-2. `enrichAndResolve().then(...)` fire-and-forget — 안전망 부분적 (codex 검증으로 갱신)
```
enrichAndResolve()
  .then(evt => turnNotifier.notify(evt))                                                [L1676~1697]
  .catch(err => handleEnrichmentFailure(err, fallbackArgs, resolveSnapshot));            [L1698]
return { success: true, ... };                                                          [L1764]
```
- `await` 없음. `execute()`는 즉시 resolve. enrich가 hang하면 카드가 영원히 안 나감.
- **3s safety net 검증 결과**: 실재함 — `packages/slack/src/turn-surface.ts:751-827`. `TurnSurface.end()`가 `buildCompletionEvent()`를 3000ms timeout과 race(`:771-791`).
- **그러나 부분적**: timeout 발생 시 B5 emit이 **skip**(`:817-825`). 즉 hang은 안 하지만 P5 경로에서 **카드는 누락**된다.
- 결론: C-2는 진짜 구멍. **fallback notify를 timeout 분기에 추가해야 함.**

### C-3. `await threadPanel?.beginTurn(turnContext)` hang
```
await this.deps.threadPanel?.beginTurn(turnContext);                                    [L785]
<try block 진입 전>
```
- try 진입 전 hang → catch/finally 모두 실행 안 됨. **카테고리 emit 자체가 없음.**
- timeout 없음. **BUG.**

### C-4. `await say(errorDetails)` hang in handleError
```
await say({text: errorDetails, thread_ts: threadTs});                                   [L2199]
```
- Slack API hang → handleError 안 끝남 → outer catch도 안 끝남 → finally의 status clear/cleanup 안 됨.
- Exception notify(L1982)는 fire-and-forget이라 영향 없지만, abort 분기는 say조차 없으므로 영향 없음.
- 그러나 normal-error 분기에서 hang하면 다음 turn 시작 시 stale 상태.

### C-5. `await cleanupTempFiles(processedFiles)` hang (L1722, L2217) — severity 격상 (codex)
```
if (processedFiles.length > 0) {
  await this.deps.fileHandler.cleanupTempFiles(processedFiles);                          [L1722, L2217]
}
```
- 파일 핸들러 hang 시 success 분기 또는 catch 분기 마지막에서 멈춤.
- **Codex 정정**: P5 경로에서는 `threadPanel.endTurn()`(L1866~1868)이 finally에서 호출되어야 카드가 뜨는 흐름인데, L1722 cleanup이 finally **이전**에 위치 → cleanup hang하면 endTurn이 호출 안 됨 → **카드도 안 뜸**.
- severity: lifecycle 누수가 아니라 **카드 누락 가능성 있음**. P1 격상.

### C-6. `summaryService.execute(session, signal)` hang
```
[in onSummaryTimerFire]
await this.deps.summaryService.execute(session, signal);                                [L2549 근처]
```
- timer 콜백 안에서 hang. main `execute()` 흐름에는 영향 없으나 summary state 누수.

---

## D. 종합 표 (codex 검증 후 갱신)

| ID | 종류 | 카드 보장? | 우선순위 |
|---|---|---|---|
| A-1 ~ A-10 | 정상 종료 10개 | ✅ 모두 보장 (의도된 침묵 포함) | — |
| B-1 | onToolUse/onToolResult ghost-session abort untagged | ❌ silent | **P0** |
| B-2 | unknown-reason abort 정책 silent fallback | ❌ silent | **P0** |
| B-3 | TurnNotifier 0-enabled-channels | ❌ silent | **P0** |
| B-4 | turnNotifier DI 누락 + abort 분기 fallback 부재 | ❌ silent | P1 |
| B-5 | 이메일 fast-fail 카드 부재 | ⚠️ 텍스트만 | P1 |
| B-6 | renew 실패 카테고리 misclassification | ⚠️ 🟢 거짓 | P1 |
| C-1 | `processor.process` 영원 hang | ✅ Phase 2 fix — `StreamProcessor.raceNextStep` 30분 idle timeout, `onIdleTimeout` → `abort('stall-timeout')` → 🔴 카드 | **fixed** |
| C-2 | enrichAndResolve hang — 3s timeout 존재하나 timeout 시 카드 skip | ❌ 카드 누락 | **P0** |
| C-3 | `beginTurn` hang | 🚫 도달 안 됨 | P1 |
| C-4 | `say(errorDetails)` hang | 부분 누수 | P2 |
| C-5 | `cleanupTempFiles` hang — P5 endTurn 호출 차단 | ❌ 카드 누락 가능 | P1 |
| C-6 | `summaryService.execute` hang | 누수 (main 흐름 무관) | P3 |

---

## E. 수정 시 동시 변경 지점 — 한 PR 안에 묶을 항목 (codex 검증 후 수정판)

다음은 PR #926 revert와 동일 PR에서 처리해야 위험 없음:

1. **B-1 수정**: `onToolUse`(L1063), `onToolResult`(L1126)에 명시적 reason 부여.
   - **~~`'session-close'`~~ 잘못됨 (codex)**. `'session-close'`는 이미 명시적 close button/expiry 액션에서 쓰임(`src/slack/actions/action-panel-action-handler.ts:355-358`, `src/slack/actions/session-action-handler.ts:45-48`). ghost-session self-abort는 이상상황(anomaly) → 별개 reason **`'ghost-session'`** 신설.
   - `'ghost-session'`은 `shouldNotifyException` 게이트에서 **notify-worthy**로 분류 (유저 모르게 세션이 죽은 거니까).

2. **B-2 정책 변경 (codex 권고)**:
   - ~~`'unknown-abort'`를 정식 `RequestAbortReason`으로 export~~ 잘못됨.
   - 올바른 정공법: (a) **producer 측에서 reason을 강제** — lint rule 또는 wrapper 함수로 untagged `abortController.abort()` 금지. (b) `coerceAbortReason`의 unknown 분기는 내부 sentinel(예: `'__unknown'`)로 매핑하고, `handleError`에서 이걸 **defense-in-depth로 notify-worthy** 처리. union 자체는 더럽히지 않음.

3. **B-3 수정**: `turn-notifier.ts` L221 zero-channels에 `logger.warn` 추가 + (선택) thread에 fallback `say` 1줄.
4. **B-4 수정**: `handleError` L2203(abort 분기)에 turnNotifier 없을 때 fallback `say` 추가.
5. **B-5 수정**: 이메일 fast-fail을 turnNotifier `Exception` 경로로 통일하거나, 최소한 카테고리 라벨이 있는 Block Kit 카드로 격상.
6. **B-6 수정**: `buildRenewContinuation` 실패 시 `Exception` 재분류 또는 enrichAndResolve 직전 category를 `'Exception'`으로 override.
7. **C-2 수정 (검증 완료)**: `TurnSurface.end`의 3s timeout은 존재하나(`turn-surface.ts:771-791`), timeout 분기에서 B5 emit이 skip됨(`:817-825`) → **timeout 분기에 fallback `turnNotifier.notify` 추가**.
8. **C-3 수정**: `threadPanel?.beginTurn` 호출을 `Promise.race([beginTurn, sleep(5s)])`로 감싸기.
9. **C-5 수정**: `cleanupTempFiles` 호출을 timeout-wrap (3s) 또는 finally로 이동. 카드 발사 보장.
10. **PR #926 revert** — **Phase 2에서 완료**: `packages/slack/src/pipeline/stream-stall-watchdog.ts` + provider shim (`src/slack/pipeline/stream-stall-watchdog.ts`) + 단위테스트 (`src/slack/pipeline/__tests__/stream-stall-watchdog.test.ts`) 삭제. `stream-executor.ts`의 arm/touch/clear 와이어 3곳 제거. `packages/slack/src/{index,pipeline/index}.ts` + `packages/slack/package.json` + `packages-srp-phase2-slack-contract.test.ts`에서 export 정리. C-1 fix는 `StreamProcessor.process` 내부 `raceNextStep` (Promise.race + per-`.next()` idle timer)로 대체.

**Codex가 지적한 추가 audit 대상 (별도 또는 동일 PR)**:

- **`V1QueryAdapter.cancel/dispose()`** (`src/agent-session/v1-query-adapter.ts:79-88`): untagged abort 가능성. B-1과 동일 패턴 의심. 직접 확인 필요.
- **`RequestAbortReason` cross-file consumers** (union 확장 시 동시 수정):
  - `packages/slack/src/request-coordinator.ts:27` (union 자체)
  - `stream-executor.ts:405-415, 1968-1982` (`KNOWN_ABORT_REASONS`, gate)
  - `packages/slack/src/pipeline/session-initializer.ts:1284-1285` (typed 사용)
  - `src/index.ts:411`
  - `src/slack/actions/action-panel-action-handler.ts:355-358`
  - `src/slack/actions/session-action-handler.ts:45-48`
  - 관련 테스트 전체

**C-1 — Phase 2에서 fix 완료.** Codex `5e6ab801-3d1a-4651-a406-f0d6c994e7db` 바인딩: `Promise.race`를 `processor.process`의 `for await` 안에 넣어 각 `iterator.next()`를 idle-timer + abort signal과 race. 기본 30분 (`SOMA_STREAM_STALL_TIMEOUT_MS` 환경변수로 유지보수, `0`은 비활성화). `'stall-timeout'` reason 재사용으로 downstream handleError 라우팅 무변경. `includePartialMessages`는 별 backlog — partials는 SDK가 emit해야 효과가 있고, 또 pending `.next()`를 직접 풀어주지는 않음. PR #926 외부 watchdog은 동일 abort 신호를 만들지만 hung `.next()` 자체를 풀지 못해서 효과가 없어서 삭제.

---

## F. 검증 요청 사항 (codex 대상) + 답변 요약

codex session: `eeecfada-18b3-4fd6-9587-3dc2fa1baec8` (2026-05-26).

1. **A 정상 경로 완전성** — ❌ 불완전. A-10(`sdkResultError`) 추가. pre-execute Slack handler exits는 scope 외 명시.
2. **B 구멍의 실재성** — ✅ 6개 모두 confirmed. B-1 메커니즘만 정정 (DOMException → `coerceAbortReason` 변환으로 효과 동일).
3. **C hang의 실재성 + 이미 걸린 timeout** — C-2의 3s safety net은 **존재**(`turn-surface.ts:771-791`)하지만 timeout 분기에서 카드 emit이 **skip**(`:817-825`) → 여전히 구멍. C-1, C-3은 timeout 없음 confirmed.
4. **`'unknown-abort'` vs lint 강제** — **lint/test 강제가 정공법**. union 더럽히지 말고 producer 측에서 reason을 강제. 내부 fallback으로만 unknown을 notify-worthy 분류.
5. **C-1 정공법** — Claude Agent SDK는 `includePartialMessages` 미사용 상태에서 heartbeat 없음 (SDK doc 기준). **`processor.process` wrapper에 idle-timeout** (SDK consumption 지점)이 옳은 위치. outer wall-clock(V1 레벨)은 잘못된 위치.

---

## G. Codex 검증 로그

| 항목 | 내 원안 | Codex 판정 | 조치 |
|---|---|---|---|
| A 경로 수 | 9개 | **10개 (A-10 `sdkResultError` 추가)** | 추가 완료 |
| Scope | unstated | pre-execute exits 별도 audit 필요 | 명시 완료 |
| B-1 메커니즘 | `signal.reason = undefined` | DOMException → `coerceAbortReason` 변환으로 효과 동일 | 정정 완료 |
| B-2~B-6 | bug 식별 | confirmed | 변동 없음 |
| C-2 safety net | "검증 필요" | 3s timeout 존재, 단 timeout 시 카드 skip — 여전히 구멍 | severity 격상, 별도 fix 항목 |
| C-5 severity | "lifecycle 누수, 카드 OK" | P5 경로에서 cleanup hang → endTurn 미호출 → 카드 누락 가능 | P1로 격상 |
| E-1 `'session-close'` 태깅 | 적합 | 잘못됨. 이미 명시적 close에서 사용. **`'ghost-session'` 신설** 필요 | 수정 완료 |
| E-2 `'unknown-abort'` 정식 export | 추가 권고 | 잘못됨. lint/test 강제 + 내부 sentinel이 정공법 | 수정 완료 |
| Cross-file consumers | 일부 누락 | `session-initializer.ts:1284`, `src/index.ts:411`, action handler 2곳 추가 | 추가 완료 |
| 신규 audit 대상 | 없음 | `V1QueryAdapter.cancel/dispose()` (`v1-query-adapter.ts:79-88`) 별도 검사 | 항목 추가 |
