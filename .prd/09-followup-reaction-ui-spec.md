# 09 — 큐/스티어링 컨트롤을 유저 메시지의 이모지 리액션으로

Status: **in-progress** (2026-09-18, 구현 완료·실측 전) · 기준 커밋 main `3229521d` · 유저 원문 = [`reaction-ui/ssot.md`](reaction-ui/ssot.md) · 선행 계약 = [`06-user-steering-spec.md`](06-user-steering-spec.md)

## 0. 한 줄 정의
미드턴 유저 메시지의 상태·컨트롤(Send now / Cancel)을 봇이 게시하는 카드가 아니라 **그 메시지에 붙는 리액션**으로 표현하고, 유저가 컨트롤 리액션을 눌러 카운트를 2로 만들면 봇이 `reaction_added`로 받아 실행한다.

## 1. AS-IS (v0.2.1143, [CODE])
- `enqueueFollowup` (`src/slack-handler.ts:2638`) → 유저 메시지에 `:inbox_tray:` 추가 → 스티어/큐 → **봇 아이템 카드** `buildFollowupItemMessage` 게시(A39, `:2669`), 카드 ref를 `followupItemMessages`에 보관(`:267`, `:2726`), 상태 변화마다 `refreshFollowupItemMessage`(`:2847`), 처리되면 `deleteFollowupItemMessages`(`:2880`).
- 컨트롤 = 카드 버튼 `FOLLOWUP_SEND_NOW_ACTION_ID` / `FOLLOWUP_CANCEL_ACTION_ID` → `src/slack/actions/followup-actions.ts` `handleSendNow` / `handleCancel` (권한 `verifyClick` + `canInterrupt`, 항목 CAS `verifyItem`).
- `reaction_added` 이벤트는 어디서도 처리하지 않는다(`packages/slack/src/event-router.ts`에 등록 없음). 봇은 `reactions.add/remove`만 쓴다(`packages/slack/src/slack-api-helper.ts:947,970`).
- 큐 항목은 원본 이벤트를 보관한다: `FollowupItem.eventKey = <channel>:<ts>`, `FollowupItem.message`(`packages/slack/src/followup-queue.ts:51-85`) → 리액션(channel, ts)에서 항목을 찾을 수 있다.

## 2. 목표 계약 (유저 원문 승계)

### 2.1 리액션 = 상태
유저 메시지 M이 큐에 들어가면 봇은 M에 다음 리액션만 붙인다. 봇 카드는 게시하지 않는다.

| 항목 상태 | M의 봇 리액션 |
|---|---|
| `queued` (턴 종료 후 드레인 대기, 또는 halt) | `:inbox_tray:` `:ui_send_now:` `:ui_cancel:` |
| `steered` (실행 중 턴에 전달됨) | 위 3개 제거 → `:white_check_mark:` (전달완료) |
| `resolved`(소비/드레인 완료) | `:white_check_mark:` 유지 |
| `cancelled` | `:inbox_tray:` `:ui_send_now:` 제거, 봇의 `:ui_cancel:` 제거(2→1, 유저 것만 남음) → `:no_entry_sign:` (캔슬완료) |
| Send now로 디스패치 | `:inbox_tray:` `:ui_cancel:` 제거, 봇의 `:ui_send_now:` 제거(2→1) → `:white_check_mark:` |
| `failed` / 거부 | `:warning:` 추가, 컨트롤은 상태에 맞게 유지 |
| `paused` (재시작 후 parked) | `:inbox_tray:` `:ui_send_now:` `:ui_cancel:` (Send now = Resume 대용) — 패널의 Resume/Retry는 그대로 |

가정 A1: 유저 원문 "스티어링되면 이모지를 제거… 처리됐다는 이모지로 변경"을 `steered` 시점으로 해석한다. steered 항목의 Cancel은 실측상 거의 항상 "이미 전달됨"이므로 컨트롤을 내리고 `queue` 명령/기존 경로에 맡긴다.

### 2.2 리액션 = 컨트롤
- 봇 이외의 사용자가 M에 `:ui_send_now:` 또는 `:ui_cancel:`을 추가(`reaction_added`, item.user ≠ bot) → 해당 항목에 대해 버튼과 **같은 핸들러**(`handleSendNow` / `handleCancel`의 정책: 권한 `canInterrupt`·항목 CAS·상태 검사)를 실행한다. 리액션은 두 번째 트랜스포트다(A39의 카드 버튼과 동일 원칙).
- 처리 결과의 거부 사유는 기존 ephemeral 문구로 클릭한 사용자에게만 알린다.
- 항목이 없거나 이미 종결된 메시지의 리액션은 무시한다(로그만).
- `reaction_removed`는 무시한다.

### 2.3 이모지
- 커스텀 이모지 `:ui_send_now:`(초록, ▶ SEND), `:ui_cancel:`(빨강, ✕ STOP) — 이미지는 `.prd/reaction-ui/assets/`(128px PNG). 워크스페이스 추가는 Claude in Chrome으로 수행.
- 이름은 설정 가능(`ui.followupReactions.{queued,sendNow,cancel,delivered,cancelled,failed}`), 기본값 위 표. `reactions.add`가 `invalid_name`이면 표준 이모지로 폴백(`arrow_forward`, `x`)하고 WARN 1회.

### 2.4 Slack 앱 요구사항
- 스코프 `reactions:read` + 봇 이벤트 `reaction_added` 구독(Socket Mode). 없으면 이벤트가 오지 않으므로 기동 시 `auth.test`/scope 확인 로그로 드러낸다.

## 3. 인수 기준 (실행 → 기대 관측치)
1. 턴 실행 중 스레드에 메시지 → 봇 카드가 게시되지 않고, 메시지에 `:inbox_tray:`가 붙었다가 스티어링 즉시 `:white_check_mark:`만 남는다.
2. 턴이 없는(드레인 대기) 상태에서 메시지 → `:inbox_tray:` `:ui_send_now:` `:ui_cancel:` 3개가 붙는다.
3. 2의 메시지에서 유저가 `:ui_cancel:` 클릭(2) → 봇이 자기 `:ui_cancel:` 제거(1), `:inbox_tray:` `:ui_send_now:` 제거, `:no_entry_sign:` 추가, 항목 `cancelled`, `queue` 명령에 나오지 않는다.
4. 2의 메시지에서 `:ui_send_now:` 클릭(2) → 항목이 디스패치되고 봇 `:ui_send_now:` 제거(1), 나머지 제거, `:white_check_mark:` 추가.
5. 권한 없는 사용자의 클릭 → ephemeral 거부, 리액션 상태 불변.
6. 기존 `queue` 명령·패널 Resume/Retry·정산(#233 경로) 회귀 없음(테스트 그린).

## 4. 비목표
- 스레드 패널 재설계, `reaction_removed` 처리, 이모지 커스터마이즈 UI.

## 5. 아키텍처 델타
- `packages/slack/src/event-router.ts`: `app.event('reaction_added')` 등록 → `onReactionAdded` 콜백(host).
- `src/slack-handler.ts`: `enqueueFollowup`에서 카드 게시 제거, `FollowupReactionSurface`(신규 모듈 `src/slack/followup-reactions.ts`)가 상태→리액션 전이를 담당(`applyState(item, prev)`), `refreshFollowupItemMessage`/`deleteFollowupItemMessages` 호출 지점이 이 surface를 호출.
- `src/slack/actions/followup-actions.ts`: `handleSendNow`/`handleCancel`을 리액션 트랜스포트에서도 호출할 수 있게 `preparsed` 값 + `FollowupRespond`(ephemeral to clicker)로 진입하는 export 추가.
