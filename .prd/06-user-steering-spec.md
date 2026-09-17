# 06 — 유저 메시지 스티어링 + 스레드 출력 모델 (spec)

Status: **in-progress** (2026-09-17, D1–D3 유저 확정) · 기준 커밋 main `5be9ad98` · 유저 원문 = [`steering/ssot.md`](steering/ssot.md)
근거 라벨: [CODE]=이 커밋의 file:line · [SDK]=`@anthropic-ai/claude-agent-sdk` 0.3.251 `sdk.d.ts` · [DOC]=공식 문서 · [LIVE]=2026-09-17 실측

## 0. 한 줄 정의

> 턴이 도는 동안 유저가 친 메시지는 큐에 들어가고, **모델을 끊지 않은 채 다음 툴 호출 경계에서 함께 전달**된다(자동 스티어링). `Send now`만이 현재 동작을 중지하고 즉시 보낸다. 큐는 스레드 맨 아래 패널에서 항상 보이고, 항목은 Edit/Cancel로 고칠 수 있다.

## 1. 문제 — 지금 무엇이 어떻게 되어 있나

### 1.1 스레드 출력 모델: 예전 vs 지금 (유저 질문 "정확히 어떻게 변경했음?")

| 표면 | PR #218 이전 (v0.2.1132) | 지금 (v0.2.1133, main 5be9ad98) | 근거 |
|---|---|---|---|
| 스레드 루트 패널 | 헤더(제목·모델·ctx)·상태·타이머·중지/세션종료 버튼. 단일 라이터 메시지 | 같은 패널에 **Queue 섹션**(항목 + `Send now` 버튼)이 추가됨. 위치는 여전히 **루트**(스레드 맨 위) | [CODE] `packages/slack/src/thread-surface.ts:1510` `buildFollowupQueueBlocks` 호출 · [LIVE] 루트 메시지 블록 덤프: section "Queue" / "1. 1234"+button / "2. 5678"+button |
| 턴 본문(B1 스트림) | `chat.startStream` 텍스트 스트림 1개/턴, 툴 이벤트는 별도 메시지 | 동일. 단, 스트림을 `task_display_mode:'plan'`으로 열고 TodoWrite를 **네이티브 task/plan 청크**로 append. 결과는 완료 메시지 안의 `plan` 블록(접힌 토글) | [CODE] `turn-surface.ts:537` startArgs, `:1596` sendTaskChunks · [LIVE] 완료 메시지에 `plan` 블록 "Tasks (5)", iq 웹 클라이언트에서 접힘→클릭 시 행 펼침 |
| 완료 카드(B5) | 스트림과 **별도 메시지**로 결과 카드 + 피드백 행 + 삭제 버튼 | **같은 스트림 메시지에 append**(`stopStream` `blocks`) — 답변 보존, 삭제 버튼 없음, 피드백 ack는 본인 전용 | [CODE] `turn-surface.ts` `closeStreamWithCompletion` · 유저 결정 2026-09-15 "답변 보존 방식" |
| 후속 메시지 | 실행 중 도착 → 즉시 abort(`supersede`) 후 새 턴 (조용히) 또는 `!prompt`로 abort-후-계속 | 실행 중 도착 → **큐에 저장**(📥) + 안내 1줄, 턴 종료 후 FIFO 드레인. `!prompt` = `Send now` 트랜잭션 | [CODE] 표 §1.2 |
| 중단 표시 | 없음(턴이 그냥 끊김) | `user-interrupted`면 부분 텍스트 flush + 헤더 "사용자 요청으로 중단" | [CODE] `stream-processor.ts:1752`, `stream-executor.ts:2553` |

### 1.2 스티어링 경로 — 무엇이 턴을 끊는가 (Explore 추적 2026-09-17, [CODE])

| 경로 | 턴 중단? | 부분 출력 보존? | 같은 SDK 세션? | 메시지 durable? |
|---|---|---|---|---|
| 예전 `!{prompt}` (`src/slack-handler.ts:961-994`) | **예** — `abortSession` 기본 `user-stop` | 아니오 | 예(`resume`로 새 프로세스) | 아니오(메모리) |
| 예전 일반 메시지(`session-initializer.ts:1360-1401` `handleConcurrency`) | **예** — `supersede` | 아니오 | 예 | 아니오 |
| 지금 큐 park(`enqueueFollowup`, `:2420-2508`) | 아니오 | — | — | **예**(디스크 선행) |
| 지금 `!prompt`/`Send now` → `sendNow`(`followup-dispatcher.ts:449-603`) | **예** — `user-interrupted`, 예약 후 abort, teardown 대기 | **예** | 예 | 예 |
| 지금 턴 종료 드레인(`v1-query-adapter.ts:174-241`) | 아니오(경계에서만) | — | 예 | 예 |

**결론: 오늘은 "턴을 끊지 않고 끼워 넣는" 경로가 존재하지 않는다.** 모든 경로가 (a) 끊거나 (b) 턴이 끝날 때까지 기다린다.

### 1.3 왜 없나 — SDK 사용 방식 [CODE][SDK]

- `query({ prompt })`의 `prompt`가 두 호출 지점 모두 **문자열**(`src/claude-handler.ts:969`, `src/agent-runtime/claude-code-runner.ts:67`). SDK 시그니처는 `string | AsyncIterable<SDKUserMessage>`(`sdk.d.ts:1928` 계열).
- `Query` 핸들을 변수에 담지 않아 `interrupt()`·`streamInput()` 등 제어 요청이 도달 불가. 모든 "중단"은 `AbortController.abort()` = 자식 프로세스 kill.
- 턴마다 새 프로세스를 `options.resume = sessionId`로 띄운다(`build-stream-options.ts:508-510`). 살아 있는 연결이 없으니 끼워 넣을 곳이 없다.
- 툴 호출 사이 훅은 `PreToolUse`만 등록(`build-stream-options.ts:255`). 훅 출력(`additionalContext`)은 모델용 문맥이지 **유저 턴이 아니다** — 스티어링 대체재가 아니다.

## 2. 리서치 — SDK가 툴 호출 사이 유저 입력을 받는 지점 [DOC][SDK]

| 메커니즘 | 전달 경계 | 끊나 | 근거 |
|---|---|---|---|
| **스트리밍 입력**: `prompt: AsyncIterable<SDKUserMessage>`로 열고 턴 중에 메시지를 yield | "툴 호출이 진행 중이면 **그 툴 호출들이 끝나는 즉시, 같은 턴 안에서** 모델에 전달. 턴이 끝났는데 남아 있으면 가장 오래된 것 하나가 다음 턴" | 아니오 | [DOC] code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works (CLI 문서; SDK 스트리밍 입력은 같은 엔진·같은 큐). SDK CHANGELOG 0.3.259/0.3.265: `user_message_uuids` "picked up mid-turn" |
| `query.interrupt()` | 즉시 중단(툴 호출 안 기다림). 결과에 `terminal_reason: aborted_*`, 잘린 메시지 `aborted:true`. **큐에 남은 메시지는 살아서 다음에 실행**(`still_queued`); `cancel_queued:true`면 함께 취소 | **예** | [SDK] `sdk.d.ts:2529-2536`, `:3926-3946` |
| `SDKUserMessage.shouldQuery:false` | 턴을 유발하지 않고 transcript에 append, 다음 질의에 병합 | 아니오 | [SDK] `sdk.d.ts:5175-5177` |
| `SDKUserMessage.priority: 'now'\|'next'\|'later'` | **미문서** — 어디에도 설명 없음 | 불명 | [SDK] `sdk.d.ts:5170` |
| `cancel_async_message` 제어 요청 | 큐의 메시지를 uuid로 실행 전 취소(dequeue 후엔 no-op) | 아니오 | [SDK] `sdk.d.ts:3439`; public `Query` 인터페이스엔 없음(`sdk.mjs`에만) |
| `command_lifecycle` 프레임 / `queued_turn_count` | 큐 관측(queued/started/completed/cancelled) | — | [SDK] `sdk.d.ts:4793`; CHANGELOG 0.3.206/0.3.243 |
| `PostToolBatch`/`PostToolUse` 훅 `additionalContext` | 툴 결과에 붙는 모델용 문맥 | 아니오 | [SDK] `sdk.d.ts:2372-2382, 2421-2430` — 유저 턴 아님, 큐/uuid 없음 |

**결론: "툴 호출 사이 자연스러운 스티어링"의 정식 통로는 스트리밍 입력 모드 하나다.** 훅은 대체재가 아니고, `priority`는 미문서라 계약에 쓰지 않는다.

버전 주의: `package.json`은 `^0.2.111`, lock은 **0.3.251**(CI 핀 테스트가 0.3.251 요구). 0.2.111에는 `still_queued`·`command_lifecycle`·`aborted:true`·`PostToolBatch`가 없다. 이 스펙은 **0.3.251 이상**을 전제한다.

미확인(스펙에서 "추정" 경계): ① 헤드리스 세션에서 도착 메시지가 진행 중 MCP 툴 호출을 끊는지(claude-code 2.1.246 노트가 시사, 문서는 "끊지 않음") ② 병렬 툴 배치의 경계가 배치 단위인지 개별 호출인지 ③ mid-turn 유저 메시지가 모델에 어떤 래퍼로 보이는지. → 구현 R1에서 실측 리시트로 확정한다.

## 3. 목표 계약 (유저 원문 4항 승계)

### 3.1 메시지 큐
- 첫 명령 이후, 턴 종료 전에 같은 스레드에서 도착한 **모든 일반 메시지**는 큐에 들어간다(디스크 선행 저장, 지금과 동일). 항목 = {seq, 원문, 작성자, 첨부, 상태}.
- 상태: `queued` → (`steered` → `consumed`) | `dispatched`(Send now 경로) | `paused` | `failed` | `uncertain` | `cancelled`. 기존 상태기계(05-architecture §5)에 **`steered`**(SDK 입력 채널로 전달됨, 모델이 아직 읽기 전) 하나를 추가한다.

### 3.2 자동 스티어링 (기본 동작)
- 큐에 들어간 `queued` 항목은 **자동으로** 현재 턴의 SDK 입력 채널에 밀어 넣는다(`SDKUserMessage`, uuid 스탬프). SDK가 다음 툴 호출 경계에서 모델에 전달한다. 모델은 끊기지 않는다.
- 전달 확인: 턴 프레임의 `user_message_uuids` 또는 `command_lifecycle started/completed`에 그 uuid가 보이면 `steered → consumed` → **큐에서 제거**(이력만 남김). 확인 전까지는 `steered`로 표시.
- 턴이 끝났는데 `steered`인 항목이 남으면(모델이 읽기 전 종료) → `queued`로 되돌리고 기존 FIFO 드레인 규칙 적용. 중복 전달 금지: uuid 기준 1회.
- 자동 스티어링 대상이 아닌 것: 컨트롤(`/`·`%` 명령, 승인 버튼 응답), 봇 합성 메시지. 첨부가 있는 메시지는 D2에 따라 대상이다.

### 3.3 Send now (명시적 중단)
- `Send now` / `!{prompt}` = 현재 동작을 **중지**하고 그 항목을 즉시 새 턴으로 실행. 부분 출력 보존·헤더 "사용자 요청으로 중단"은 지금 규칙 유지.
- 스트리밍 입력 모드에서는 `query.interrupt()`로 끊고, `still_queued`에 남은 uuid는 큐 상태(`steered`→`queued`)로 되돌린다. 프로세스 kill(AbortController)은 interrupt 실패·타임아웃(R1 실측값)에서만 폴백.
- 바로 `!`(빈 프롬프트) = 중지만.

### 3.4 Edit / Cancel
- **Cancel**: `queued`·`paused`·`failed`·`uncertain`은 즉시 `cancelled`. `steered`는 `cancel_async_message(uuid)` 시도 → 성공이면 `cancelled`, 이미 dequeue됐으면 "이미 전달됨"으로 거부(consumed로 전이). 실행 중(`dispatched`)은 거부 — 중지 버튼으로.
- **Edit**: 유저가 Slack에서 자기 큐 메시지를 **편집**(`message_changed` 이벤트)하면, 항목이 `queued`면 원문을 갱신(epoch bump). `steered`/`consumed`면 갱신 불가 → 안내 1줄. 별도 편집 UI는 만들지 않는다(Slack 편집이 곧 Edit).

### 3.5 표시 — 스레드 최하단 패널 (별도 워크스트림 `feat/queue-panel-tail`과 합류)
- 큐가 비어 있지 않거나 턴이 도는 동안, 결합 패널은 **스레드의 마지막 메시지**여야 한다(봇이 뒤에 무언가 올리면 삭제·재게시). 컴팩트: 항목당 1줄 `n. 원문 · 상태` + 우측 메뉴(Send now / Cancel / Retry / Resume).
- `steered` 항목은 상태에 "전달됨 · 모델이 다음 툴 호출에서 읽음"으로 표시하고 `consumed`가 되면 사라진다.

## 4. 인수 기준 (명령형: 실행 → 기대 관측치)

| # | 시나리오 | 기대 관측치 |
|---|---|---|
| S1 | 긴 작업(툴 호출 ≥3) 시작 → 도중에 일반 메시지 M 전송 | M이 📥로 큐에 들어가고 패널에 `queued`로 보인다 → 다음 툴 호출 경계 후 패널에서 사라지고, 같은 턴의 후속 출력에 M의 내용이 반영된다. 스트림 메시지는 **하나**(새 턴 없음), 헤더에 중단 표시 없음 |
| S2 | S1에서 M 전송 직후(모델이 읽기 전) Cancel | 항목 `cancelled`, 모델 출력에 M 미반영, 턴은 계속 |
| S3 | S1에서 M이 `steered`인데 턴이 먼저 종료 | M이 `queued`로 돌아와 기존 드레인으로 새 턴에서 실행(1회만) |
| S4 | 실행 중 `Send now` | 현재 스트림에 부분 텍스트 + "사용자 요청으로 중단", 그 항목이 새 턴으로 즉시 실행, 다른 `queued` 항목은 남아 있음 |
| S5 | `queued` 항목의 Slack 메시지를 편집 | 패널 원문이 갱신됨; `steered` 항목 편집은 안내 1줄 + 미반영 |
| S6 | 턴 진행 중 봇이 스레드에 새 메시지 게시 | 패널이 삭제·재게시되어 스레드 마지막에 위치(3초 내), 패널 메시지 수는 항상 1 |
| S7 | 프로세스 재시작(큐에 `steered` 1건) | 복원 후 `paused`(자동 실행 금지), Resume 가능 — 05 §5 A16 규칙 |
| S8 | 게이트 | `npm run build && npx tsc --noEmit && npm test` exit 0; A35 실측(스트리밍 입력 모드에서 S1을 실제 Slack 스레드로 1회) |

## 5. 비목표
- `agent_view`/assistant 표면 전환(비가역, 미인가). 편집용 모달 UI. 병렬 다중 턴. `priority` 필드 사용(미문서).

## 6. 아키텍처 델타 (02/05 위에 얹는 결정)

1. **세션 어댑터를 스트리밍 입력 모드로 전환**: 턴마다 프로세스를 새로 띄우되, `prompt`를 AsyncIterable(초기 메시지 + 턴 동안 열린 채널)로 준다. `Query` 핸들을 세션 상태에 보관해 `interrupt()`·(캐스트) `cancelAsyncMessage(uuid)`를 쓴다. 턴 종료 시 채널을 닫는다. → 기존 "턴 = 프로세스 1개, resume로 연속" 모델은 유지(변경 최소).
2. **FollowupDispatcher에 `steer(sessionKey, itemId)`** 추가: `queued → steered`(uuid 발급·persist) 후 채널에 push. 드레인 루프와 상호배타(steered 항목은 claimNext 대상 아님).
3. **StreamProcessor**가 `user_message_uuids`/`command_lifecycle`를 관측해 `consumed` 전이를 호스트에 통지.
4. **Send now**는 `interrupt()` → `still_queued` 처리 → 기존 `sendNow` 트랜잭션(예약·세대·대기)을 그대로 탄다. AbortController는 폴백.
5. 큐 항목 편집은 `message_changed`를 EventRouter에서 큐로 라우팅.

## 7. 유저 결정 (2026-09-17 확정, 원문: "D1. 자동 스티어링 ㅇㅋ / D2. 첨부도 스티어링 ㅇㅋ / D3. ㅇㅋ")
- D1. 자동 스티어링 기본 **ON**. 제외는 §3.2의 컨트롤·합성 메시지뿐.
- D2. **첨부가 있는 메시지도 자동 스티어링** — 이미지는 SDK 메시지 content 블록으로, 그 외 파일은 현재 파이프라인의 파일 처리(다운로드·경로 주입)를 거친 텍스트로 전달. 첨부 처리 실패 시 그 항목만 `queued` 유지 + 안내.
- D3. Edit = Slack 메시지 편집(`message_changed`)으로 갈음, 별도 UI 없음.
