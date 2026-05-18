# Slack 세션 처리 경로 — 알고리즘 SSOT

**스코프:** soma-work Slack 봇이 유저 메시지를 어떻게 세션으로 변환·라우팅·유지·종료하는지 정의한다. 5개 처리 경로(일반 / 미드-스레드 멘션 / 커맨드 / 인라인(TO-BE) / DM)를 각각 AS-IS 알고리즘과 TO-BE 결정사항으로 문서화.

**이 문서의 위상:** 코드가 근거다. 모든 서술에 `src/…:L…` 링크가 붙어 있다. 서술이 코드와 어긋나면 코드를 믿고 이 문서를 수정하라.

**기준 커밋:** `a66d3f78a` (2026-04-18).
**관련 문서:** [`algorithms.md`](./algorithms.md) — pseudocode. [`terminology.md`](./terminology.md) — 용어 사전.

---

## 0. 유저 인식 vs 실구현 gap 3가지

유저·설계자의 멘탈 모델과 실제 코드가 어긋나는 지점. 문서화가 필요한 이유.

### Gap 1. "채널에 새 대화 스레드 시작" = 봇이 top-level 메시지를 쓴다

- **인식:** 유저가 봇을 멘션하면 Slack이 새 스레드를 만들어주고 세션이 거기 붙는다.
- **실제:** 봇이 **채널에 `thread_ts` 없이 `chat.postMessage`를 호출해 새 top-level 메시지를 post**하고, 그 메시지의 `ts`를 스레드 루트로 삼는다. 이 분기를 `createBotInitiatedThread`라고 부른다 — [src/slack/pipeline/session-initializer.ts:752](../../src/slack/pipeline/session-initializer.ts). 기존 세션은 `terminateSession`되고 원본 스레드에는 🧵 링크 한 줄만 남는다.
- **영향:** "새 스레드"는 채널에 봇이 발언권을 한 번 쓰는 공격적인 UX. 봇 멘션이 채널 문서 흐름을 깨는 원인.

### Gap 2. 미드-스레드 판별은 `thread_ts` 유무가 아니라 `mentionTs !== threadTs`

- **인식:** 스레드 안에서 멘션하면 모두 "미드-스레드 세션"이다.
- **실제:** `isMidThreadMention(ctx) = !!ctx.mentionTs && ctx.mentionTs !== ctx.threadTs` — [src/mcp-config-builder.ts:94](../../src/mcp-config-builder.ts). 즉 **멘션 메시지의 `ts`가 스레드 parent의 `ts`와 다를 때만** 미드-스레드. 스레드 parent에서 멘션하면 미드-스레드가 아니다.
- **영향:** `slack-mcp` MCP 서버가 등록되는 조건이 이거다 — [src/mcp-config-builder.ts:188](../../src/mcp-config-builder.ts). 즉 모델이 원본 스레드를 직접 읽을 권한은 **미드-스레드에서만** 주어진다.

### Gap 3. DM은 특별 처리가 없다. 세션 키 공식이 같다

- **인식:** DM은 채널 멘션과 다른 경로로 관리된다.
- **실제:** DM 세션 키 = `${channelId}-${threadTs || 'direct'}` — [src/session-registry.ts:216](../../src/session-registry.ts). 채널 멘션 공식과 동일. DM에서 `thread_ts`가 없으면 **해당 DM 채널 전체가 `'direct'` 단일 세션으로 수렴**한다. 즉 봇과의 모든 DM 대화가 무한정 한 세션에 쌓인다.
- **영향:** DM 다중 토픽 관리가 불가능. 유저가 "대책없이 막 작동"으로 체감하는 근본 원인.

---

## 1. 5개 처리 경로 개요

| # | 경로 | 진입 조건 | 세션 생성 | slack-mcp 등록 | 현재 `threadModel` 기본값 |
|---|------|-----------|-----------|----------------|----------------------------|
| 1 | 일반 세션 | 채널 멘션, `thread_ts` 없음 (채널 top-level) | 예 (대부분 bot-initiated로 새 스레드 생성) | 아니요 | `bot-initiated` |
| 2 | 미드-스레드 멘션 세션 | 채널 멘션, `mentionTs !== threadTs` | 예 (bot-initiated로 새 스레드 생성 + sourceThread 기록) | **예** | `bot-initiated` |
| 3 | 커맨드 처리 | 첫 단어가 커맨드 키워드 또는 `/`, `$`, `%`, `!` prefix | 아니요 (커맨드 일부 예외: `new <prompt>`) | 해당 없음 | 해당 없음 |
| 4 | 인라인 세션 (**TO-BE**) | 유저가 명시적으로 인라인 모드 선택 | 예 (user-initiated, 원본 스레드 유지) | 현재 경로 2와 동일 로직 재사용 | `user-initiated` |
| 5 | DM 세션 | `channel_type=im` (`D`로 시작) | 예 (thread 당 1 세션, **TO-BE**로 thread 승격 추가) | 미드-스레드와 동일 조건 적용 | `bot-initiated` (현) → TO-BE에서 thread 승격 |

---

## 2. 공통 인프라

### 2.1 엔트리 라우터

Bolt App이 Socket Mode로 붙는다 — [src/index.ts:14](../../src/index.ts). 이벤트 구독은 `EventRouter.setupMessageHandlers()` 하나로 집중.

- **DM 전용 `app.message`** — [src/slack/event-router.ts:91](../../src/slack/event-router.ts). 채널 ID가 `D`로 시작하고 `subtype`이 없을 때만 `this.messageHandler`로 위임. DM은 이 경로가 **유일한 권위 핸들러**다.
- **`app.event('app_mention')`** — [src/slack/event-router.ts:111](../../src/slack/event-router.ts). 봇 멘션. 파일 첨부가 있으면 `file_share` 핸들러로 양보하고 early-return ([L123-128](../../src/slack/event-router.ts)).
- **`app.event('message')`** — [src/slack/event-router.ts:187](../../src/slack/event-router.ts). 멘션 없는 메시지. `file_share`는 `handleFileUpload`로, `subtype===undefined && thread_ts`는 `handleThreadMessage`로 분기 ([L208-216](../../src/slack/event-router.ts)). **DM은 여기서 early-return** 된다([L636-654](../../src/slack/event-router.ts), Issue #553).
- **Slash commands** — [src/slack/event-router.ts:338](../../src/slack/event-router.ts) `/z`, [L415](../../src/slack/event-router.ts) `/soma` (legacy tombstone), [L438](../../src/slack/event-router.ts) `/session` (legacy), [L459](../../src/slack/event-router.ts) `/new` (legacy). `/z`가 통합 엔트리이고 나머지 3개는 `/z`로 리다이렉트 안내만 한다.

### 2.2 세션 키와 라이프사이클

세션 키는 **채널과 스레드로만 구성**된다. 유저 ID는 무시된다.

```
getSessionKey(channelId, threadTs?) = `${channelId}-${threadTs || 'direct'}`
```

근거:
- 정의: [src/session-registry.ts:216](../../src/session-registry.ts).
- userId 무시 (legacy 호환): [src/session-registry.ts:223](../../src/session-registry.ts) — `getSessionKeyWithUser`가 내부적으로 `getSessionKey`로 위임.
- `SessionRegistry`의 내부 맵 `sessions: Map<string, ConversationSession>` 키가 이 수식.

**라이프사이클 연산:**
- `createSession(ownerId, ownerName, channelId, threadTs, model?)` — [src/session-registry.ts:319](../../src/session-registry.ts). 새 세션을 `INITIALIZING` 상태로 생성하고 키에 저장.
- `findSessionBySourceThread(channel, threadTs)` — [src/session-registry.ts:252](../../src/session-registry.ts). 미드-스레드에서 파생된 bot-initiated 세션을 원본 스레드로 역조회.
- `terminateSession(sessionKey)` — [src/session-registry.ts:1218](../../src/session-registry.ts). bot-initiated 마이그레이션 시 원본 세션 종료에 사용.

**세션 상태 필드 (TO-BE 결정에 핵심):**
- `threadModel: 'user-initiated' | 'bot-initiated'` — [src/session-registry.ts:103](../../src/session-registry.ts), 타입 정의 [src/types.ts:178](../../src/types.ts). **타입은 이미 존재하나 `user-initiated` 경로는 거의 사용되지 않음**.
- `threadRootTs?: string` — [src/session-registry.ts:104](../../src/session-registry.ts), [src/types.ts:180](../../src/types.ts). bot-initiated 세션의 새 스레드 루트.

### 2.3 디스패치 (workflow classifier)

세션 진입 직후 유저 메시지를 classifier 프롬프트로 돌려 workflowType을 결정한다.

- `DISPATCH_PROMPT_PATH` 로드: [src/dispatch-service.ts:28](../../src/dispatch-service.ts), [L70-81](../../src/dispatch-service.ts).
- `dispatch(userMessage, abortSignal?)`: [src/dispatch-service.ts:125](../../src/dispatch-service.ts). 내부에서 `claudeHandler.dispatchOneShot(...)` 호출 — [L174](../../src/dispatch-service.ts).
- **Valid workflows** (11종): [src/dispatch-service.ts:466](../../src/dispatch-service.ts) `VALID_WORKFLOWS` — `onboarding`, `jira-executive-summary`, `jira-brainstorming`, `jira-planning`, `jira-create-pr`, `pr-review`, `pr-fix-and-update`, `pr-docs-confluence`, `deploy`, `default`.
- **PR 라우팅 허용 워크플로우** (3종): [src/slack/pipeline/session-initializer.ts:347](../../src/slack/pipeline/session-initializer.ts) `PR_ROUTABLE_WORKFLOWS`.

### 2.4 동일 키 동시 dispatch 락 (30초 타임아웃)

같은 세션 키로 두 요청이 동시에 들어오면 뒤 요청이 앞 요청의 완료를 **최대 30초 기다린다**. 그 뒤엔 드랍된다.

- `dispatchInFlight: Map<string, Promise<void>>` — [src/slack/pipeline/session-initializer.ts:29](../../src/slack/pipeline/session-initializer.ts).
- race prevention: [src/slack/pipeline/session-initializer.ts:309](../../src/slack/pipeline/session-initializer.ts).
- set/delete: [L585, L724](../../src/slack/pipeline/session-initializer.ts).

**현재 이건 큐가 아니라 단순 "in-flight면 기다렸다 드롭"**. Q2 TO-BE에서 FIFO 큐로 확장된다(§6.2).

### 2.5 Bot-initiated thread 생성 = "새 스레드 시작"

신규 세션 대다수가 이 분기를 탄다. **유저가 말하는 "채널에 새 대화 스레드 시작"의 실구현**.

- 정의: [src/slack/pipeline/session-initializer.ts:752](../../src/slack/pipeline/session-initializer.ts) `createBotInitiatedThread(...)`.
  - **핵심:** `postMessage(channel, headerPayload.text, { blocks, attachments })`를 **`threadTs` 없이** 호출 — 새 top-level 메시지 생성. 반환된 `rootResult.ts`가 새 스레드 루트가 된다.
  - `createSession(user, userName, channel, rootResult.ts, session.model)` — [L786](../../src/slack/pipeline/session-initializer.ts). 새 세션을 새 루트 아래로.
  - `threadModel='bot-initiated'` + `threadRootTs=rootResult.ts` 기록.
  - 기존 세션 `terminateSession`.
  - 원본(initiator) 스레드 cleanup + 🧵 링크 메시지.
- 호출 지점: [L492](../../src/slack/pipeline/session-initializer.ts) (PR 라우팅 OK 케이스), [L514](../../src/slack/pipeline/session-initializer.ts) (PR 라우팅 SKIP 케이스). **두 케이스 모두 migrate**.
- 응답 스레드 결정: [src/slack/event-router.ts:788](../../src/slack/event-router.ts) — `workThreadTs = session.threadRootTs || session.threadTs`.

### 2.6 커맨드 라우터

32+ 종 커맨드를 우선순위 순으로 등록 — [src/slack/commands/command-router.ts:48](../../src/slack/commands/command-router.ts) `CommandRouter`.

- 등록 순서: [L53-91](../../src/slack/commands/command-router.ts). `LlmChat → Admin → Prompt → ... → SkillForce ($local:skill) → SessionCommand ($ prefix) → ... → New → Compact → Link → Close → ... → SessionHandler` (more specific first).
- `/z` prefix strip: [L112](../../src/slack/commands/command-router.ts) — `stripZPrefix`로 `/z …` 잘라내고 legacy 문법으로 번역.
- 첫 `canHandle` 매치 wins: [L140](../../src/slack/commands/command-router.ts).
- 미인식이지만 "커맨드 같아 보이는" 텍스트는 `handled:true`로 마킹해 Claude 진입 차단: [L161](../../src/slack/commands/command-router.ts).

특수 prefix:
- `$` — `SessionCommandHandler` ([L66](../../src/slack/commands/command-router.ts)).
- `$local:<skill>` — `SkillForceHandler` ([L65](../../src/slack/commands/command-router.ts)).
- `!` — abort ([src/slack-handler.ts:301-329](../../src/slack-handler.ts)).

---

## 3. 경로 1 — 일반 세션 (채널 멘션, top-level)

### 3.1 AS-IS 알고리즘

1. 채널에서 유저가 `@bot <prompt>` 멘션. Slack이 `app_mention` 이벤트 발송.
2. [src/slack/event-router.ts:111](../../src/slack/event-router.ts) `app.event('app_mention')` 수신.
3. [L123-128](../../src/slack/event-router.ts): 첨부 파일 있으면 `file_share` 핸들러에 양보 → return.
4. [L131-138](../../src/slack/event-router.ts): 봇 멘션만 제거하고 유저 멘션은 보존.
5. [L150-156](../../src/slack/event-router.ts): `/z` prefix면 `maybeRouteAppMentionViaZRouter`로. terminal 처리면 return.
6. [L166-174](../../src/slack/event-router.ts): `event.thread_ts`가 있고 기존 세션이 없으면 `findSessionBySourceThread`로 linked session 조회. 있으면 카드 회신만 하고 return. **(여기서 thread_ts 조건을 타서 경로 2로 넘어감)**
7. thread_ts 없음(top-level) → `messageHandler`로 위임.
8. 세션 initializer가 `dispatch`를 돌려 workflowType 결정.
9. [src/slack/pipeline/session-initializer.ts:492 or 514](../../src/slack/pipeline/session-initializer.ts): `createBotInitiatedThread` 호출 → **새 스레드 루트 생성 + 세션 migrate** (Gap 1).
10. 세션 key = `${channel}-${rootResult.ts}` (§2.2), `threadModel='bot-initiated'`, `threadRootTs=rootResult.ts`.
11. 이후 응답은 `workThreadTs = session.threadRootTs` ([src/slack/event-router.ts:788](../../src/slack/event-router.ts))에 붙여서 post.

### 3.2 세션 키 결정 과정

- 유저 멘션 메시지의 ts → 버려짐 (이 ts는 세션 루트가 아님).
- 봇이 채널에 post한 새 메시지의 ts → **세션 루트**.
- 최종 키: `${event.channel}-${rootResult.ts}`.

### 3.3 slack-mcp 등록 여부

**등록 안 됨.** `isMidThreadMention`이 false — 멘션이 top-level이라 `mentionTs`와 `threadTs`가 둘 다 정의되지 않거나 같음. 따라서 모델은 스레드 히스토리 도구를 받지 않는다.

---

## 4. 경로 2 — 미드-스레드 멘션 세션

### 4.1 AS-IS 알고리즘

1. 채널 기존 스레드 안에서 유저가 `@bot <prompt>` 멘션. Slack이 `app_mention` 이벤트 발송 (`event.thread_ts`에 parent ts, `event.ts`에 reply ts).
2. event-router가 `app_mention` 수신, 3~5단계는 경로 1과 동일.
3. [src/slack/event-router.ts:166-174](../../src/slack/event-router.ts): `event.thread_ts`가 있다 → 기존 세션 조회. 이미 linked session이 있으면 해당 세션의 카드만 회신하고 return (**중복 세션 생성 방지**).
4. 기존 세션 없으면 `messageHandler`로 위임.
5. dispatch로 workflowType 결정.
6. **미드-스레드 판별** — [src/slack/pipeline/stream-executor.ts:220](../../src/slack/pipeline/stream-executor.ts) 또는 [src/mcp-config-builder.ts:94, 188](../../src/mcp-config-builder.ts): `isMidThreadMention({ threadTs, mentionTs })`가 true → `slack-mcp` MCP 서버 등록.
   - `SLACK_MCP_CONTEXT` env 주입 — [src/mcp-config-builder.ts:466](../../src/mcp-config-builder.ts). 내용: `{ channel, threadTs, mentionTs, sourceThreadTs, sourceChannel }`.
   - allowlist에 `mcp__slack-mcp__*` 추가 — [src/mcp-config-builder.ts:539](../../src/mcp-config-builder.ts).
   - 모델은 `mcp__slack-mcp__get_thread_messages(offset, limit)`로 원본 스레드를 offset/limit 페이징해 읽을 수 있다 ([src/slack-handler.ts:875](../../src/slack-handler.ts) 참조).
7. 경로 1과 동일하게 `createBotInitiatedThread`로 새 스레드 루트 생성 + migrate. 단 새 세션에 `sourceThread = { channel, threadTs }` 기록 — [src/slack/pipeline/session-initializer.ts:786](../../src/slack/pipeline/session-initializer.ts) 근처.
8. 새 스레드에 "원본 스레드에서 migrated" 컨텍스트 요약 post. 원본 스레드에 🧵 링크 post.

### 4.2 세션 키 결정 과정

경로 1과 동일. 원본 스레드의 `thread_ts`는 **세션 키에 쓰이지 않고 `sourceThread` 필드에만 기록**된다.

### 4.3 slack-mcp 등록 조건 (Gap 2)

- `mentionTs`: 유저가 멘션한 메시지의 ts (= `event.ts`).
- `threadTs`: 원본 스레드 parent ts (= `event.thread_ts`).
- `mentionTs === threadTs`: 유저가 스레드 parent에서 멘션 → 미드-스레드 **아님**. slack-mcp 등록 안 됨.
- `mentionTs !== threadTs`: 유저가 스레드 reply에서 멘션 → 미드-스레드. slack-mcp 등록.

---

## 5. 경로 3 — 커맨드 처리

### 5.1 AS-IS 알고리즘

1. 메시지 첫 단어가 커맨드 키워드 또는 `/`, `$`, `%`, `!` prefix.
2. `CommandRouter.route(ctx)` 호출 — [src/slack/commands/command-router.ts:99](../../src/slack/commands/command-router.ts).
3. `stripZPrefix(originalText)` — [L112](../../src/slack/commands/command-router.ts). `/z …` 이면 remainder 추출 후 legacy 문법으로 번역.
4. 등록된 32+ 핸들러를 우선순위 순으로 `canHandle` 체크 — [L140](../../src/slack/commands/command-router.ts).
5. 첫 매치 핸들러의 `execute(ctx)` 호출.
6. 미인식이지만 "커맨드 같아 보이는" 텍스트는 `handled:true` 마킹 — [L161](../../src/slack/commands/command-router.ts). Claude 세션 진입 **차단**.
7. [src/slack-handler.ts:360-366](../../src/slack-handler.ts): 커맨드 성공(handled && !continueWithPrompt) 시 🤖 → ⚡ 이모지 교체 후 return. **세션 생성 안 함**.
8. 예외 — `new <prompt>` / `/z new <prompt>`: [src/slack-handler.ts:381](../../src/slack-handler.ts) `continueWithPrompt`로 세션 초기화 계속.

### 5.2 특수 prefix

- `$` — `SessionCommandHandler` (세션 설정) — [src/slack/commands/command-router.ts:66](../../src/slack/commands/command-router.ts).
- `$local:<skill>` — `SkillForceHandler` — [L65](../../src/slack/commands/command-router.ts).
- `!` — abort — [src/slack-handler.ts:301-329](../../src/slack-handler.ts).
- `%` — whitelist regex ([src/slack/z/whitelist.ts:93](../../src/slack/z/whitelist.ts) `SAFE_Z_TOPICS`)에서 허용.
- `/z` — 통합 entry ([src/slack/commands/command-router.ts:112](../../src/slack/commands/command-router.ts)).

### 5.3 커맨드 결과 스레드

커맨드는 **이니시에이션 스레드에 그대로 회신**한다. 새 bot-initiated 스레드 안 만든다. `say()`로 응답 — Bolt의 `say`는 수신 context의 thread_ts를 자동 상속.

---

## 6. 경로 4 — 인라인 세션 (**TO-BE** 신규)

### 6.1 정의

유저 멘션 스레드 안에서 **새 스레드로 migrate하지 않고** 그대로 세션을 진행한다. `threadModel='user-initiated'`.

### 6.2 진입 트리거

- 커맨드 `$inline` 또는 `/z inline <prompt>` — 단발성 스위치.
- `$` prefix 설정 (per-user): `$inline=on` 유지. 세션 만들 때마다 user-initiated 적용.

두 경로 모두 `SessionCommandHandler` ([src/slack/commands/command-router.ts:66](../../src/slack/commands/command-router.ts)) 에 새 서브커맨드로 추가.

### 6.3 행동 (구현 포인트)

1. `createBotInitiatedThread` 분기를 `skipBotInitiatedThread` 플래그로 감싸기 — [src/slack/pipeline/session-initializer.ts:492, 514](../../src/slack/pipeline/session-initializer.ts).
2. 플래그가 true면 **migrate 스킵**. 대신 `createSession(user, userName, channel, threadTs=event.thread_ts || event.ts, model)`로 **원본 스레드 안에서** 세션 생성, `threadModel='user-initiated'`, `threadRootTs` 세팅 안 함.
3. 응답 스레드 결정 로직([src/slack/event-router.ts:788](../../src/slack/event-router.ts))은 변경 없음 — `threadRootTs` 없으면 `threadTs`로 fallback.
4. slack-mcp 등록은 경로 2와 동일 조건(`isMidThreadMention`). 유저 인라인 세션이 기존 스레드 reply에서 시작되면 자연스럽게 등록됨.

### 6.4 관측성

- 세션 dashboard 카드에 `threadModel` 뱃지 표시.
- 로그에 `threadModel` 필드 추가.

### 6.5 회귀 범위

- `src/slack/pipeline/session-initializer-routing.test.ts` — bot-initiated 분기 플래그별 테스트 분리.
- `src/slack-handler.test.ts` — `threadModel` 단언 추가.

---

## 7. 경로 5 — DM 세션

### 7.1 AS-IS 알고리즘

1. 유저가 봇에 DM 메시지 전송. Slack이 `message` 이벤트 발송 (`channel_type='im'`, `channel`이 `D`로 시작).
2. **`app.message` 권위 핸들러** — [src/slack/event-router.ts:91-108](../../src/slack/event-router.ts). `channel`이 `D`로 시작하고 `subtype` 없을 때만 통과.
3. `app.event('message')`에서는 [L636-654](../../src/slack/event-router.ts) DM early-return (Issue #553). **중복 수신 방지**.
4. `messageHandler` ([src/slack-handler.ts:252](../../src/slack-handler.ts)) 로 위임.
5. DM 게이트 A — [src/slack-handler.ts:256](../../src/slack-handler.ts): `handleDmCleanupRequest` (봇 메시지 일괄 삭제 요청 처리).
6. DM 게이트 A-2 — [L269-275](../../src/slack-handler.ts): 비-admin이면 `isDmAllowedForNonAdmin(text)` 체크, 거부.
7. DM 게이트 A-3 — [L284-294](../../src/slack-handler.ts): `stripZPrefix(dmText) !== null`이면 `routeDmViaZRouter`로 라우팅 ([정의 L598](../../src/slack-handler.ts)).
8. DM 게이트 B — [L374-378](../../src/slack-handler.ts): 비-admin의 미라우팅 DM 거부.
9. 세션 생성 시 키 = `${channel}-${thread_ts || 'direct'}` — 채널 경로와 **동일 공식** (§2.2).
10. thread_ts 없으면 `'direct'` 단일 세션으로 수렴 (Gap 3).

### 7.2 비-admin DM whitelist

- `SAFE_Z_TOPICS` regex — [src/slack/z/whitelist.ts:93](../../src/slack/z/whitelist.ts). help/sessions/theme/`%.../$...` 허용.
- `isWhitelistedNaked(text)` — [src/slack/z/whitelist.ts:30](../../src/slack/z/whitelist.ts).

### 7.3 slack-mcp 등록

DM에서도 경로 2와 동일 조건 — `mentionTs !== threadTs`일 때 등록. DM thread에서 추가 멘션이 없으므로 실사용 거의 없음.

---

## 8. TO-BE 결정사항 (유저 승인 2026-04-19)

### 8.1 Q1 — 미드-스레드 migrate 정책을 옵션화

**결정:** `threadModel` enum을 유저가 선택. 기본값은 현재 동작(`bot-initiated`, 새 스레드 migrate) 유지.

**구현 포인트:**
- 세션 설정: `SessionCommandHandler` ([src/slack/commands/command-router.ts:66](../../src/slack/commands/command-router.ts))에 `$threadModel=user|bot` 추가.
- 단발 커맨드: `/z inline <prompt>` — 이 메시지만 user-initiated.
- `createBotInitiatedThread` 분기에 `skipBotInitiatedThread` 플래그 도입 — [src/slack/pipeline/session-initializer.ts:492, 514](../../src/slack/pipeline/session-initializer.ts).
- `createSession` 호출부에서 `threadModel` 명시.

**호환성:** `threadModel` 타입은 이미 존재 ([src/types.ts:178](../../src/types.ts)). 스키마 변경 0. 신규 회귀 테스트만 추가.

**비-목표 (이 PR 아님):** UI 배지, 세션 migration 도구.

### 8.2 Q2 — 동일 스레드 다중 세션 = FIFO 큐 + 상태 알림

**결정:** 기존 `dispatchInFlight: Map`을 FIFO 큐로 확장. 두 번째 요청은 대기 + 🕒 reaction + "대기열: N/5" 상태 업데이트.

**구현 포인트:**
- 자료구조: `dispatchQueue: Map<sessionKey, Array<QueuedRequest>>` + 기존 `dispatchInFlight` — [src/slack/pipeline/session-initializer.ts:29](../../src/slack/pipeline/session-initializer.ts) 근처에 신규 필드.
- 진입부: [src/slack/pipeline/session-initializer.ts:309](../../src/slack/pipeline/session-initializer.ts)의 `existingDispatch` 처리를 "enqueue + 상태 post"로 변경.
- 해제부: [L724](../../src/slack/pipeline/session-initializer.ts)의 `delete` 시 큐 dequeue + 다음 요청 실행.
- 타임아웃: per-request 30s 유지 + 큐 최대 길이 5 (초과 시 가장 오래된 요청 drop + DM 공지).

**관측성:** 큐 길이 메트릭, Slack 메시지 Block Kit에 "대기열: 2/5" 상태 라인.

**비-목표:** 병렬 subSession, 세션 키 스키마 변경.

### 8.3 Q3 — DM 세션 전략 = 1-per-thread (Slack Assistant pattern)

**결정:** DM 첫 메시지 수신 시 봇 첫 응답에 `thread_ts = event.ts`를 붙여서 post → 유저 메시지가 자동으로 스레드 parent가 된다. 이후 모든 reply가 thread에 속한다. 세션 키 `${channel}-${thread_ts}` 재사용.

**선행 사례:**
- Slack 공식 Assistant 패턴 — [docs.slack.dev/tools/bolt-js/concepts/adding-agent-features](https://docs.slack.dev/tools/bolt-js/concepts/adding-agent-features/).
- [vercel-labs/ai-sdk-slackbot@5806bb4 handle-messages.ts](https://github.com/vercel-labs/ai-sdk-slackbot/blob/5806bb4/lib/handle-messages.ts).
- [slack-samples/bolt-js-assistant-template@386cd1f](https://github.com/slack-samples/bolt-js-assistant-template/blob/386cd1f2502e7b1c2ed88cf2ed37c7d1282e0fae/listeners/assistant/index.js).

**구현 포인트:**
- [src/slack/event-router.ts:91-108](../../src/slack/event-router.ts)의 DM `app.message` 핸들러에서 `messageHandler`에 넘기기 전 `event.thread_ts = event.thread_ts || event.ts` 적용.
- 봇 응답 post 시 `thread_ts`를 항상 명시.
- 기존 `'direct'` 세션에 붙어 있던 유저는 **1회 공지 후 다음 DM부터 thread 승격** — 마이그레이션 스크립트 불필요(세션이 alive면 그대로 쓰고, 새 메시지부터 새 키).

**비-목표 (follow-up 이슈):** `assistant_thread_started` / `assistant.threads.setStatus` 훅, Slack Assistant container 사이드패널 UX.

### 8.4 후속 이슈 분리 가이드

이 문서는 설계 결정의 SSOT다. 실제 구현은 아래 3개 이슈로 분리한다:
- `feat(slack-session): Q1 threadModel 옵션화 + 인라인 세션 경로`
- `feat(slack-session): Q2 dispatch FIFO 큐 + 대기열 상태 UI`
- `feat(slack-session): Q3 DM 1-per-thread Assistant pattern 적용`

---

## 9. 참고

### 9.1 주요 테스트 파일
- `src/slack/event-router.test.ts` — DM 권위 핸들러, app_mention.
- `src/slack/event-router-source-thread.test.ts` — source-thread 재-멘션.
- `src/slack/event-router-slash-commands.test.ts` — `/z` `/soma` `/session` `/new`.
- `src/slack/event-router-app-mention-z.test.ts` — app_mention `/z` 라우팅.
- `src/slack/pipeline/session-initializer-midthread.test.ts` — 미드-스레드.
- `src/slack/pipeline/session-initializer-routing.test.ts` — PR 채널 라우팅.
- `src/slack-handler.test.ts` — bot-initiated migration, `sourceThread`, DM cleanup.
- `src/session-registry.test.ts`, `src/session-registry-working-dir.test.ts`, `src/session-workspace-isolation.test.ts`.

### 9.2 관련 외부 문서
- [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage) — `thread_ts`, `reply_broadcast`.
- [Slack Events: app_mention](https://docs.slack.dev/reference/events/app_mention), [message.im](https://docs.slack.dev/reference/events/message.im), [message](https://docs.slack.dev/reference/events/message).
- [Slack bolt-js adding-agent-features](https://docs.slack.dev/tools/bolt-js/concepts/adding-agent-features/) — `(channel_id, thread_ts)` 공식 세션 키.
- [slackapi/bolt-js#1370](https://github.com/slackapi/bolt-js/issues/1370) — `say()` vs `client.chat.postMessage` 차이.
- [slackapi/bolt-python#994](https://github.com/slackapi/bolt-python/issues/994) — 동시성 락 교훈.
