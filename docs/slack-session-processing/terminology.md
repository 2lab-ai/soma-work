# Slack 세션 처리 — 용어 사전

**관계:** [`spec.md`](./spec.md)·[`algorithms.md`](./algorithms.md)에서 사용하는 용어. Slack 공식 용어(영어 원문)와 soma-work 내부 용어를 매핑.
**기준 커밋:** `a66d3f78a` (2026-04-18).

## 표기

- **Slack 공식 용어는 영어 원문을 그대로 사용.** 번역은 "~(영문)" 형태로 괄호 병기.
- **soma-work 내부 용어는 코드 심볼을 그대로 사용.** 예: `threadModel`, `sourceThread`, `SessionKey`.
- 인용 소스: Slack API 공식 문서 또는 코드 심볼 정의 위치.

---

## 1. Slack 공식 용어 (외부 어휘)

### 1.1 `thread_ts` (스레드 루트 타임스탬프)

- **정의:** 스레드 부모 메시지의 `ts`. reply에서는 이 필드가 parent의 `ts`를 가리킨다.
- **출처:** [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage) — *"Provide another message's ts value to post this message in a thread."*
- **규칙:**
  - Top-level 메시지는 `thread_ts`가 없다 (또는 자기 자신 `ts`와 같다).
  - 스레드 parent에서 포스트된 event는 종종 `event.thread_ts === event.ts` 이거나 `event.thread_ts` 자체가 없다.
  - 스레드 reply는 `event.ts`(자기 ts)와 `event.thread_ts`(parent ts)가 **다르다**.
- **soma-work 활용:** 세션 키 공식의 핵심 — [src/session-registry.ts:216](../../src/session-registry.ts).

### 1.2 `ts` (메시지 타임스탬프 / 메시지 ID)

- **정의:** Slack 내부에서 메시지 ID 역할을 하는 `"1234567890.123456"` 형식의 문자열.
- **출처:** [Slack message payload](https://docs.slack.dev/reference/events/message).
- **soma-work 활용:** `mentionTs = event.ts` — 유저 멘션 메시지의 ts. 미드-스레드 판별에 사용.

### 1.3 `channel_type`

- **값:** `channel`, `group`, `im`, `mpim` 등.
- **출처:** [Slack message event](https://docs.slack.dev/reference/events/message).
- **soma-work 활용:** `channel_type === 'im'` = DM. 채널 ID가 `D`로 시작함과 동치 — [src/slack/event-router.ts:91](../../src/slack/event-router.ts).

### 1.4 `app_mention` (app_mention event)

- **정의:** 봇이 멘션(`<@Ubot>`)된 메시지에 대해서만 발송되는 이벤트 타입.
- **출처:** [Slack app_mention event](https://docs.slack.dev/reference/events/app_mention).
- **soma-work 활용:** 채널 멘션 경로(1, 2)의 권위 엔트리 — [src/slack/event-router.ts:111](../../src/slack/event-router.ts).

### 1.5 `message.im` / `message.channels`

- **정의:** `message` 이벤트의 channel_type별 변형. `message.im`은 DM 전용, `message.channels`는 public channel.
- **출처:** [Slack message.im](https://docs.slack.dev/reference/events/message.im).
- **soma-work 활용:** Bolt JS의 `app.message` subscribe 필터(DM 한정) — [src/slack/event-router.ts:91](../../src/slack/event-router.ts).

### 1.6 `subtype`

- **정의:** message 이벤트의 변형 지시자. `file_share`, `message_changed`, `message_deleted` 등.
- **출처:** [Slack message subtypes](https://docs.slack.dev/reference/events/message#subtypes).
- **soma-work 활용:** `subtype === undefined` 조건으로 순수 유저 메시지만 통과 — [src/slack/event-router.ts:208](../../src/slack/event-router.ts).

### 1.7 `reply_broadcast`

- **정의:** 스레드 reply를 채널 top-level에도 브로드캐스트하는 chat.postMessage 옵션.
- **출처:** [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage).
- **soma-work 활용:** 현재 사용 안 함. 추후 세션 migration 공지 UX에서 검토 대상.

### 1.8 `channel` (채널 ID)

- **정의:** `Cxxxx`(public), `Gxxxx`(private), `Dxxxx`(DM), `Gxxxx`(mpim) 형식의 식별자.
- **출처:** [Slack conversations](https://docs.slack.dev/reference/objects/conversation-object).
- **soma-work 활용:** 세션 키의 앞 토큰.

### 1.9 Slack Assistant / Assistant thread / Assistant container

- **정의:** Slack의 "AI 어시스턴트" UX 패턴. `assistant_thread_started`, `assistant.threads.setStatus` 등 전용 API와 사이드패널 UI를 묶어 1-per-thread 어시스턴트 세션을 구현.
- **출처:** [Slack Bolt JS: adding agent features](https://docs.slack.dev/tools/bolt-js/concepts/adding-agent-features/). 참고 구현: [slack-samples/bolt-js-assistant-template@386cd1f](https://github.com/slack-samples/bolt-js-assistant-template/blob/386cd1f2502e7b1c2ed88cf2ed37c7d1282e0fae/listeners/assistant/index.js).
- **soma-work 활용:** Q3 TO-BE — **세션 키는 기존 `${channelId}-${threadTs}` 그대로**, DM 첫 응답에 `thread_ts=event.ts`를 붙여 thread 승격만 적용. `assistant.threads.setStatus` API 연동은 후속 이슈.

---

## 2. soma-work 내부 용어 (코드 어휘)

### 2.1 session / ConversationSession

- **정의:** 유저-봇 한 스레드 간 대화 상태 1개. 정의: [src/session-registry.ts:56](../../src/session-registry.ts) `ConversationSession` 타입.
- **필드 일부:** `ownerId`, `ownerName`, `channelId`, `threadTs`, `threadModel`, `threadRootTs?`, `sourceThread?`, `model`, `status`.

### 2.2 session key / SessionKey

- **정의:** `${channelId}-${threadTs || 'direct'}` — [src/session-registry.ts:216](../../src/session-registry.ts).
- **주의:** userId는 키에 포함되지 않는다. `getSessionKeyWithUser`는 legacy alias — [src/session-registry.ts:223](../../src/session-registry.ts).

### 2.3 `threadModel` enum

- **정의:** `'user-initiated' | 'bot-initiated'` — [src/types.ts:178](../../src/types.ts), [src/session-registry.ts:103](../../src/session-registry.ts).
- **`bot-initiated`:** 봇이 channel에 새 top-level 메시지를 post해 스레드 루트를 직접 생성. **현재 기본값**.
- **`user-initiated`:** 유저 메시지/스레드를 그대로 세션 루트로 삼음. 현 코드 경로에서는 **거의 사용되지 않음** (타입만 존재). Q1 TO-BE가 이 경로를 사용화.

### 2.4 `threadRootTs`

- **정의:** bot-initiated 세션에서 봇이 만든 새 스레드 루트의 `ts` — [src/session-registry.ts:104](../../src/session-registry.ts), [src/types.ts:180](../../src/types.ts).
- **응답 라우팅:** `workThreadTs = session.threadRootTs || session.threadTs` — [src/slack/event-router.ts:788](../../src/slack/event-router.ts).

### 2.5 `sourceThread`

- **정의:** 미드-스레드 세션이 파생된 원본 스레드 레퍼런스. `{ channel, threadTs }` — 미드-스레드에서 bot-initiated로 migrate할 때 기록.
- **역조회:** `findSessionBySourceThread(channel, threadTs)` — [src/session-registry.ts:252](../../src/session-registry.ts).

### 2.6 `mentionTs`

- **정의:** 유저 멘션 메시지의 `ts`. 대부분 경우 `event.ts`.
- **용처:** `isMidThreadMention(ctx) = !!ctx.mentionTs && ctx.mentionTs !== ctx.threadTs` — [src/mcp-config-builder.ts:94](../../src/mcp-config-builder.ts).

### 2.7 mid-thread mention (미드-스레드 멘션)

- **정의:** `mentionTs !== threadTs`인 app_mention. 스레드 reply에서 봇을 멘션한 경우.
- **효과:** `slack-mcp` MCP 서버 등록 — [src/mcp-config-builder.ts:188](../../src/mcp-config-builder.ts).

### 2.8 `createBotInitiatedThread`

- **정의:** 채널에 새 top-level 메시지를 post → 그 `ts`를 새 세션 루트로 삼는 분기. [src/slack/pipeline/session-initializer.ts:752](../../src/slack/pipeline/session-initializer.ts).
- **호출 지점:** [L492](../../src/slack/pipeline/session-initializer.ts) (PR 라우팅 OK), [L514](../../src/slack/pipeline/session-initializer.ts) (PR 라우팅 SKIP).
- **부작용:** 기존 세션 `terminateSession`, 원본 스레드 🧵 링크, 새 스레드 migrated 컨텍스트 post.

### 2.9 `skipBotInitiatedThread` (**TO-BE** 신규)

- **정의:** Q1 TO-BE로 도입될 플래그. true이면 `createBotInitiatedThread` 분기 스킵하고 `threadModel='user-initiated'`로 원본 스레드에 세션 생성.
- **현재 미구현.**

### 2.10 `dispatch` (workflow classifier)

- **정의:** 유저 메시지를 classifier 프롬프트로 돌려 workflowType을 결정하는 one-shot LLM 호출 — [src/dispatch-service.ts:125](../../src/dispatch-service.ts).
- **valid workflows(11종):** `onboarding`, `jira-executive-summary`, `jira-brainstorming`, `jira-planning`, `jira-create-pr`, `pr-review`, `pr-fix-and-update`, `pr-docs-confluence`, `deploy`, `default` — [src/dispatch-service.ts:466](../../src/dispatch-service.ts) `VALID_WORKFLOWS`.
- **PR 라우팅 가능 workflows(3종):** [src/slack/pipeline/session-initializer.ts:347](../../src/slack/pipeline/session-initializer.ts) `PR_ROUTABLE_WORKFLOWS`.

### 2.11 `dispatchInFlight` (dispatch 락)

- **정의:** `Map<sessionKey, Promise<void>>` — 동일 세션 키 concurrent dispatch 방지 — [src/slack/pipeline/session-initializer.ts:29](../../src/slack/pipeline/session-initializer.ts).
- **AS-IS 동작:** in-flight면 최대 30s 대기 후 drop ([L309](../../src/slack/pipeline/session-initializer.ts)).
- **TO-BE 확장 (Q2):** `dispatchQueue`와 함께 FIFO 큐로 재구성.

### 2.12 `dispatchQueue` (**TO-BE** 신규)

- **정의:** Q2 TO-BE로 도입될 `Map<sessionKey, Array<QueuedRequest>>` — [spec.md §8.2](./spec.md).
- **현재 미구현.**

### 2.13 `inline session` (**TO-BE** 신규)

- **정의:** Q1 TO-BE의 신규 경로 이름. `threadModel='user-initiated'` + migrate 스킵 = 유저가 멘션한 원본 스레드에서 그대로 세션 진행.
- **트리거(예상):** 커맨드 `$inline` 또는 `/z inline <prompt>` 또는 per-user 설정 `$threadModel=user-initiated`.

### 2.14 `CommandRouter`

- **정의:** 32+ 개 핸들러를 우선순위 순으로 등록한 라우터 — [src/slack/commands/command-router.ts:48](../../src/slack/commands/command-router.ts).
- **`stripZPrefix`:** `/z …` 프리픽스 제거 유틸 — [command-router.ts:112](../../src/slack/commands/command-router.ts).
- **`canHandle` first-wins:** 앞에 등록된 핸들러가 우선 — [L140](../../src/slack/commands/command-router.ts).
- **looks-like-command block:** 미인식이지만 커맨드 형태면 Claude 진입 차단 — [L161](../../src/slack/commands/command-router.ts).

### 2.15 `SAFE_Z_TOPICS` (비-admin DM 화이트리스트)

- **정의:** 비-admin 유저가 DM에서 쏠 수 있는 텍스트 패턴 regex — [src/slack/z/whitelist.ts:93](../../src/slack/z/whitelist.ts).
- **체크 함수:** `isWhitelistedNaked(text)` — [src/slack/z/whitelist.ts:30](../../src/slack/z/whitelist.ts).

### 2.16 `slack-mcp`

- **정의:** soma-work의 MCP 서버. 스레드 히스토리 읽기·파일 다운로드 등 제공.
- **등록 조건:** `isMidThreadMention(ctx) === true` — [src/mcp-config-builder.ts:188](../../src/mcp-config-builder.ts).
- **환경 주입:** `SLACK_MCP_CONTEXT` JSON — [src/mcp-config-builder.ts:466](../../src/mcp-config-builder.ts). 필드: `channel`, `threadTs`, `mentionTs`, `sourceThreadTs`, `sourceChannel`.
- **Allowlist:** `mcp__slack-mcp__*` — [src/mcp-config-builder.ts:539](../../src/mcp-config-builder.ts).
- **대표 도구:** `mcp__slack-mcp__get_thread_messages(offset, limit)` — [src/slack-handler.ts:875](../../src/slack-handler.ts) 관련 사용.

### 2.17 `/z` (통합 entry command)

- **정의:** soma-work의 단일 슬래시 entry command. `/soma`, `/session`, `/new`는 legacy tombstone — [src/slack/event-router.ts:338, 415, 438, 459](../../src/slack/event-router.ts).
- **파싱:** `/z <cmd> <args>`. `<cmd>` 빈 문자열이면 help.

### 2.18 `$` / `$local:` / `%` / `!` prefix

- **`$<cmd>`:** 세션 설정 (`SessionCommandHandler`) — [src/slack/commands/command-router.ts:66](../../src/slack/commands/command-router.ts).
- **`$local:<skill>`:** 로컬 skill 강제 실행 (`SkillForceHandler`) — [command-router.ts:65](../../src/slack/commands/command-router.ts).
- **`%…`:** 비-admin whitelist 통과 패턴 — [src/slack/z/whitelist.ts:93](../../src/slack/z/whitelist.ts).
- **`!`:** 실행 중 세션 abort — [src/slack-handler.ts:301](../../src/slack-handler.ts).

---

## 3. 매핑표 (Slack 공식 ↔ soma-work 내부)

| Slack 공식 (영문 원문) | soma-work 내부 | 출처 |
|---|---|---|
| `thread_ts` | `threadTs`, 세션 키 두 번째 토큰 | [src/session-registry.ts:216](../../src/session-registry.ts) |
| `ts` of mention | `mentionTs` | [src/mcp-config-builder.ts:94](../../src/mcp-config-builder.ts) |
| `channel_type='im'` | `channel.startsWith('D')` 로 동치 체크 | [src/slack/event-router.ts:91](../../src/slack/event-router.ts) |
| `app_mention` event | app.event('app_mention') 핸들러 | [src/slack/event-router.ts:111](../../src/slack/event-router.ts) |
| `message.im` filtered | `app.message`(DM-only 필터) | [src/slack/event-router.ts:91](../../src/slack/event-router.ts) |
| threaded reply (= `ts !== thread_ts`) | `isMidThreadMention` | [src/mcp-config-builder.ts:94](../../src/mcp-config-builder.ts) |
| Assistant thread (`1-per-thread`) | TO-BE Q3 DM thread 승격 | [spec.md §8.3](./spec.md) |
| `assistant.threads.setStatus` | **미연동** (follow-up 이슈) | — |
| `reply_broadcast` | **미사용** | — |

---

## 4. 상태 어휘

### 4.1 session status

- 세션 상태 값 — `src/session-registry.ts` 내 `SessionStatus` 타입.
- 대표값: `INITIALIZING`, `ACTIVE`, `TERMINATED` 등. 전이는 코드 참조.

### 4.2 reaction 이모지

- `👀`: 세션 진입 확인 / 메시지 수신.
- `⚡`: 커맨드 성공 처리 — [src/slack-handler.ts:360-366](../../src/slack-handler.ts).
- `🤖` → `⚡`: 세션 start → 커맨드 성공 교체.
- `🕒` (**TO-BE** Q2): 큐 대기 중 표시.
- `🧵`: 원본 스레드 cleanup에서 남기는 링크 마커.
