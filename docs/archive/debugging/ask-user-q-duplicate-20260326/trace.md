# Bug Trace: ASK_USER_QUESTION 2회 연속 호출 시 UI 미표시

## AS-IS
model-command → run(ASK_USER_QUESTION)을 한 턴에 2번 호출하면 MCP는 둘 다 ok:true를 반환하지만, Slack 스레드에 선택 버튼 UI가 하나도 표시되지 않음.

## TO-BE
ASK_USER_QUESTION이 여러 번 호출되어도 선택 UI가 정상 표시되어야 함.

## Phase 1: Heuristic Top-3

### Hypothesis 1: Slack API rate limit으로 chat.postMessage 2회 연속 실패
- `stream-executor.ts:1516` → `context.say()` (chat.postMessage) 호출
- `stream-executor.ts:1502` → 첫 번째 호출 후 `setActivityState('waiting')` + `updateRuntimeStatus` (chat.update × 2)
- 첫 번째 say → 성공 → attachChoice → renderViaFlush(chat.update) → updateRuntimeStatus → renderViaFlush(chat.update)
- 두 번째 say → **chat.postMessage가 rate limit에 걸릴 가능성**
- 하지만 첫 번째도 안 나온다는 것은 rate limit만으론 설명 불가 ❌ **부분 설명**

### Hypothesis 2: handleModelCommandToolResults 루프에서 순차 렌더 시 상태 간섭
- `stream-executor.ts:1388-1488` → for 루프가 toolResults를 순차 처리
- 첫 번째 ASK_USER_QUESTION:
  1. `context.say()` → Slack message 포스트
  2. `attachChoice()` → `renderViaFlush(force=true)` → action panel에 choiceBlocks 설정 + 렌더
  3. `updateRuntimeStatus()` → `renderViaFlush(force=false)` → 한번 더 렌더
- 두 번째 ASK_USER_QUESTION:
  1. `context.say()` → Slack message 포스트 (첫 번째 후 ~600ms 이내)
  2. `attachChoice()` → choiceBlocks **덮어쓰기** → 렌더
  3. `updateRuntimeStatus()` → 렌더
- 핵심: chat.postMessage × 2 + chat.update × 4 = 6회 Slack API 호출이 ~1초 안에 일어남
- Slack rate limit (chat.postMessage ≈ 1/sec/channel)에 첫 번째 say 성공, 두 번째 say 실패 시:
  - 두 번째는 catch → sendCommandChoiceFallback → 또 say() → 이것도 rate limit → **unhandled throw**
  - `renderAskUserQuestionFromCommand`에 try/catch 없음 → 에러 전파
  - 첫 번째 메시지는 이미 포스트됐지만, 전체 handleModelCommandToolResults가 에러로 중단 가능

  → **그러나** 유저는 "유저 입력 대기"가 2번 표시된다고 했으므로 에러 전파는 아닌 듯 ❌

### Hypothesis 3: say() 성공하지만 Slack 클라이언트에서 메시지 미표시 (attachments 렌더 이슈)
- `choice-message-builder.ts:104-111` → 반환값: `{ attachments: [{ color, blocks }] }`
- Slack은 `attachments[].blocks`를 렌더하는데, 동일 thread에 짧은 간격으로 두 메시지가 동시에 도착하면 Slack 클라이언트가 첫 번째를 건너뛸 수 있음
- **가능성 있지만 입증 불가** ❌

## Phase 2: Root Cause — Design Defect

코드에 명백한 단일 버그는 없다. 문제의 본질은 **설계적 취약점**:

1. `handleModelCommandToolResults`가 ASK_USER_QUESTION을 만날 때마다 즉시 렌더링하므로, 한 턴에 2회 이상이면 짧은 간격에 chat.postMessage가 반복됨
2. `sendCommandChoiceFallback`에 try/catch가 없어 rate limit 시 에러 전파 가능
3. `attachChoice()`가 choiceBlocks를 덮어쓰므로 마지막 것만 action panel에 남음
4. `renderAskUserQuestionFromCommand`에 error handling이 없어 fallback 실패 시 상태 불일치

## Fix Strategy

1. **코어 수정**: handleModelCommandToolResults에서 ASK_USER_QUESTION 결과를 **수집만** 하고, 루프 종료 후 마지막 하나만 렌더링. 이전 것은 경고 로그.
2. **방어 수정**: sendCommandChoiceFallback에 try/catch 추가
3. **방어 수정**: renderAskUserQuestionFromCommand에 try/catch 추가
