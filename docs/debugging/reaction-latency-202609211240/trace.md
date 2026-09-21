# Bug Trace: reaction-latency — 미드턴 메시지의 Cancel 리액션이 늦게 붙고, 그 사이 취소가 안 됨

## AS-IS (유저 원문 2026-09-21)
> 미드턴에 메세지보내고 바로 취소 눌러도 취소가 안되네 … 지금 취소 이모지가 좇나 늦게 떠 … 왜 지금 실행 이모지랑 취소 이모지가 서로 다른 시간에 추가됨?

## TO-BE (PRD 09 §2.1 / 유저 원문 TO-BE)
메시지를 보내면 `📥` `ui_send_now` `ui_cancel` 세 리액션이 **한꺼번에, 즉시** 붙고, 모델이 읽기 전에는 Cancel이 통한다.

## Phase 1: 휴리스틱 Top-3

### 가설 1: 리액션 3개가 두 단계·순차로 붙는다 — ✅ 확정 (원인 A)
- `src/slack-handler.ts` `enqueueFollowup`: (1) `paintFollowupReactions(... roles: ['queued'])` = 📥만 → (2) `await this.trySteerFollowup(...)` → (3) `syncFollowupReactions(...)` = `ui_send_now`, `ui_cancel` 추가.
  주석: "The controls are not painted yet on purpose — the steer below usually takes the message into the running turn, and a `Send now` that appeared for 200ms before being removed again…" — **PR #239 이후 `steered`도 같은 3개 리액션이라 이 사유는 소멸**. 이 지연 설계가 남아 있음.
- `src/slack/followup-reactions.ts:354-360` `applyRoles`: `for (const role of ops.add) { await this.add(...) }` — 순차 await. 각 add = Slack API 호출 1회.

### 가설 2: 모든 Slack API 호출이 단일 FIFO 레이트리밋 큐를 지난다 — ✅ 확정 (원인 B)
- `packages/slack/src/slack-api-helper.ts:361-420` `enqueue()`/`processQueue()`: 토큰 버킷 `bucketSize 10, refillRate 3/s, minInterval 100ms`, FIFO. `reactions.add`(`:951`)와 스트리밍 `chat.update`(`:810`)가 **같은 큐**.
- 실측 로그 2026-09-21T03:27:08–17Z: 턴 스트리밍 중 `Rate limit: waiting for token {"waitTime":334,"queueLength":5~8}` 연속. 리액션 add 1개당 큐 대기 + 334ms 토큰 대기 → 📥, (스티어 후) ui_send_now, ui_cancel 이 각각 수백 ms~수 초 간격으로 붙음.

### 가설 3: 유저가 누른 시점엔 이미 모델이 읽었다 — ✅ 확정 (결과)
- 로그 `03:27:45.743Z Queue control reaction ignored — the state does not offer it {"itemId":"…#17","state":"resolved","op":"cancel"}` — 직전 `item-consumed` 03:27:42.404Z. 컨트롤이 늦게 뜬 만큼 클릭이 늦었고, 그 사이 모델이 다음 툴 경계에서 읽음.
- 추가 결함: 이 경우 유저에게 아무 안내 없음(debug 로그만). 버튼 경로는 ephemeral을 줌.

## Phase 2: 완전탐색 — 불필요 (top-3 모두 확정, 서로 연쇄)

## 결론
원인 A(2단계·순차 페인트) × 원인 B(공용 FIFO 큐에서 스트리밍 chat.update 뒤에 줄 섬) → 컨트롤 표시 지연 → 가설 3(클릭 시점엔 resolved).

## 수정
1. enqueue 시 3개 리액션을 **한 번의 페인트**로, 스티어 **전**에 붙인다(steered = 같은 roles라 플래시 없음).
2. 큐 컨트롤 리액션 add/remove는 API 헬퍼 큐의 **우선 레인**(큐 앞에 삽입)으로 보낸다. 스트리밍 chat.update 뒤에서 기다리지 않는다.
3. 3개 add를 병렬 발행(우선 레인 안에서 연속 3개).
4. resolved/consumed 항목에 Cancel 리액션 → ephemeral "이미 모델이 읽어 실행 중입니다"(무시하지 않음).
