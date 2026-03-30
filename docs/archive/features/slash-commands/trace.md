# Slack Slash Commands — Vertical Trace

> STV Trace | Created: 2026-03-25
> Spec: docs/slash-commands/spec.md

## Table of Contents

1. [Scenario 1 — Manifest & EventRouter Registration](#scenario-1)
2. [Scenario 2 — /soma with Valid Subcommand](#scenario-2)
3. [Scenario 3 — /soma with Empty/Unknown Subcommand](#scenario-3)
4. [Scenario 4 — /session Ephemeral Session List](#scenario-4)
5. [Scenario 5 — /new Thread Context Fallback](#scenario-5)

---

## Scenario 1 — Manifest & EventRouter Registration

Infrastructure: slash command 등록 및 라우팅 파이프라인 구축.

### 1. Entry Point
- Slack App manifest에 3개 slash command 정의
- `EventRouter.setup()` → `setupSlashCommands()` 호출
- `app.command('/soma', handler)`, `app.command('/session', handler)`, `app.command('/new', handler)` 등록

### 2. Input
- Manifest YAML:
  ```yaml
  slash_commands:
    - command: /soma
      description: Claude Code Bot commands (help, model, persona, etc.)
      usage_hint: "[help|model|persona|sessions|bypass|mcp|plugins|...]"
      should_escape: false
    - command: /session
      description: View and manage your bot sessions
      usage_hint: ""
      should_escape: false
    - command: /new
      description: Reset session and start fresh conversation
      usage_hint: "[optional prompt]"
      should_escape: false
  ```
- OAuth scope 추가:
  ```yaml
  oauth_config:
    scopes:
      bot:
        - commands   # ← NEW
  ```
- Interactivity 활성화 (slash command 수신에 필요):
  ```yaml
  settings:
    interactivity:
      is_enabled: true   # ← CHANGED from false
  ```

### 3. Layer Flow

#### 3a. Manifest Files
- `slack-app-manifest.yaml`: `slash_commands` 섹션 추가, `commands` scope 추가, `interactivity.is_enabled: true`
- `slack-app-manifest.json`: 동일 내용 JSON 형식

#### 3b. EventRouter (`src/slack/event-router.ts`)
- `setup()` 메서드에 `this.setupSlashCommands()` 추가
- Transformation: `setup()` → 기존 `setupMessageHandlers()` 다음에 `setupSlashCommands()` 호출

#### 3c. SlashCommandAdapter (`src/slack/slash-command-adapter.ts`) — NEW FILE
- Static utility class
- `adapt(command, respond)` → `CommandContext` 변환
- `wrapRespondAsSay(respond)` → Slack `respond()` 함수를 `SayFn` 시그니처로 래핑

### 4. Side Effects
- 앱 재설치 필요 (manifest 변경 시 Slack App 재설정)
- Socket Mode에서 slash command 이벤트 수신 시작

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| `commands` scope 누락 | Slack API 오류 | 앱 설치 시 scope 에러 |
| `interactivity` 비활성 | slash command 미수신 | Socket Mode에서 이벤트 안 옴 |

### 6. Output
- EventRouter가 3개 slash command를 리스닝
- 각 command에 대해 `ack()` → adapter → CommandRouter 파이프라인 작동

### 7. Observability
- Logs: `Logger('EventRouter')` — `'Slash command received'`, `{ command, user, channel }`
- Logs: `Logger('SlashCommandAdapter')` — `'Adapted slash command to CommandContext'`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `SlashCommandAdapter_adapt_transformsPayloadToCommandContext` | Contract | S1, Section 3c |
| `SlashCommandAdapter_wrapRespondAsSay_callsRespondWithCorrectArgs` | Contract | S1, Section 3c |
| `EventRouter_setupSlashCommands_registersThreeCommands` | Happy Path | S1, Section 3b |

---

## Scenario 2 — /soma with Valid Subcommand

유저가 `/soma help`, `/soma model list` 등 유효한 subcommand를 입력.

### 1. Entry Point
- Slack Event: slash command `/soma`
- Bolt middleware: `app.command('/soma', async ({ command, ack, respond, say }) => { ... })`

### 2. Input
- SlashCommand payload:
  ```json
  {
    "command": "/soma",
    "text": "help",
    "user_id": "U094E5L4A15",
    "channel_id": "C0AKY7W2UGZ",
    "trigger_id": "xxx",
    "response_url": "https://hooks.slack.com/commands/..."
  }
  ```
- Validation: `command.text` 비어있지 않음, CommandRouter가 인식하는 명령

### 3. Layer Flow

#### 3a. EventRouter.setupSlashCommands()
- `ack()` 즉시 호출 (3초 제한)
- `command.text` 추출: `"help"`
- Transformation: `SlashCommand.text("help")` → `SlashCommandAdapter.adapt(command, respond)`

#### 3b. SlashCommandAdapter.adapt()
- Transformation arrows:
  - `SlashCommand.user_id` → `CommandContext.user`
  - `SlashCommand.channel_id` → `CommandContext.channel`
  - `SlashCommand.channel_id` → `CommandContext.threadTs` (slash command에 thread_ts 없으므로 channel을 대용)
  - `SlashCommand.text` → `CommandContext.text` (그대로 전달)
  - `respond` → `CommandContext.say` (wrapRespondAsSay로 래핑: `respond({ text, response_type: 'ephemeral' })`)

#### 3c. CommandRouter.route(ctx)
- 기존 로직 그대로: `handler.canHandle("help")` → `HelpHandler` 매치
- `HelpHandler.execute(ctx)` → `ctx.say({ text: helpMessage, thread_ts: ctx.threadTs })`
- `say`가 `respond`로 래핑되어 있으므로 ephemeral 응답

### 4. Side Effects
- 없음 (조회 명령)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| CommandRouter가 명령 처리 중 exception | catch → ephemeral 에러 메시지 | `respond({ text: '⚠️ 명령 처리 중 오류', response_type: 'ephemeral' })` |

### 6. Output
- Ephemeral 메시지: help 텍스트 (기존 `CommandParser.getHelpMessage()` 내용)
- 채널의 다른 유저에게는 보이지 않음

### 7. Observability
- Logs: `Logger('EventRouter')` — `'Slash command /soma'`, `{ text: 'help', user: 'U094E5L4A15', channel: 'C0AKY7W2UGZ' }`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `soma_help_returnsHelpMessageViaRespond` | Happy Path | S2, Section 3c |
| `soma_modelList_routesToModelHandler` | Happy Path | S2, Section 3c |
| `soma_subcommand_ackCalledImmediately` | Contract | S2, Section 3a |
| `soma_handlerException_returnsEphemeralError` | Sad Path | S2, Section 5 |

---

## Scenario 3 — /soma with Empty/Unknown Subcommand

유저가 `/soma` 만 입력하거나 `/soma asdf` 같은 미인식 명령 입력.

### 1. Entry Point
- 동일: `app.command('/soma', ...)`

### 2. Input
- Case A: `command.text = ""` (빈 입력)
- Case B: `command.text = "asdf"` (미인식 명령)

### 3. Layer Flow

#### 3a. EventRouter.setupSlashCommands()
- `ack()` 즉시 호출
- `command.text` → `SlashCommandAdapter.adapt()`

#### 3b. SlashCommandAdapter.adapt()
- Case A (빈 입력): `text = ""` → EventRouter에서 즉시 help 메시지 fallback (CommandRouter 미진입)
- Case B (미인식): `text = "asdf"` → CommandRouter → `isPotentialCommand` → false → `handled: false` → EventRouter가 help fallback 표시

#### 3c. Response
- Case A: help 메시지를 ephemeral로 표시 (빈 입력 = help와 동일하게 처리)
- Case B: help 메시지를 ephemeral로 표시 (미인식 텍스트도 help fallback — 더 나은 UX)

### 4. Side Effects
- 없음

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| 빈 텍스트 | N/A | help 메시지 fallback |
| 미인식 명령 | 기존 CommandRouter 로직 | ephemeral 안내 메시지 |

### 6. Output
- Case A: Ephemeral help 메시지
- Case B: Ephemeral help 메시지 (CommandRouter가 처리하지 못한 경우 help fallback)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `soma_emptyText_returnsHelpMessage` | Sad Path | S3, Section 3b, Case A |
| `soma_unknownSubcommand_returnsErrorMessage` | Sad Path | S3, Section 3b, Case B |

---

## Scenario 4 — /session Ephemeral Session List

유저가 `/session` 입력 시 자신의 세션 목록을 ephemeral로 표시.

### 1. Entry Point
- `app.command('/session', async ({ command, ack, respond, say }) => { ... })`

### 2. Input
- SlashCommand payload:
  ```json
  {
    "command": "/session",
    "text": "",
    "user_id": "U094E5L4A15",
    "channel_id": "C0AKY7W2UGZ"
  }
  ```

### 3. Layer Flow

#### 3a. EventRouter.setupSlashCommands()
- `ack()` 즉시 호출
- `/session`은 전용 핸들링: CommandRouter를 거치지 않고 직접 SessionHandler 로직 호출
- Transformation: `SlashCommand.user_id` → `userId` for session lookup

#### 3b. SessionHandler 로직 재사용
- `sessionUiManager.formatUserSessionsBlocks(userId, { showControls: true })` 호출
- 기존 SessionHandler의 ephemeral 분기와 동일한 결과
- Transformation: `SlashCommand.user_id` → `formatUserSessionsBlocks(userId)` → `{ text, blocks }`

#### 3c. Response
- `respond({ text, blocks, response_type: 'ephemeral' })` 로 응답
- kill 버튼 포함 (showControls: true)

### 4. Side Effects
- 없음 (조회)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| 활성 세션 없음 | N/A | "활성 세션이 없습니다" ephemeral 메시지 |
| sessionUiManager 오류 | catch | ephemeral 에러 메시지 |

### 6. Output
- Ephemeral: 세션 목록 + kill 버튼 blocks
- 세션 없으면: "활성 세션이 없습니다"

### 7. Observability
- Logs: `Logger('EventRouter')` — `'Slash command /session'`, `{ user, channel }`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `session_withActiveSessions_returnsEphemeralList` | Happy Path | S4, Section 3b |
| `session_noActiveSessions_returnsEmptyMessage` | Sad Path | S4, Section 5 |
| `session_respond_calledWithEphemeralType` | Contract | S4, Section 3c |

---

## Scenario 5 — /new Thread Context Fallback

유저가 `/new` 또는 `/new fix the bug` 입력. thread_ts가 없으므로 fallback.

### 1. Entry Point
- `app.command('/new', async ({ command, ack, respond, say }) => { ... })`

### 2. Input
- SlashCommand payload:
  ```json
  {
    "command": "/new",
    "text": "fix the bug",
    "user_id": "U094E5L4A15",
    "channel_id": "C0AKY7W2UGZ"
  }
  ```
- **thread_ts: 없음** (SlashCommand에 thread_ts 필드 없음 — bolt 타입 확인 완료)

### 3. Layer Flow

#### 3a. EventRouter.setupSlashCommands()
- `ack()` 즉시 호출
- `/new`는 thread_ts가 필요하지만 SlashCommand payload에 없음
- **Fallback 경로 선택**

#### 3b. Fallback Response
- Ephemeral 메시지로 안내:
  ```
  💡 `/new` 명령은 스레드 내에서만 사용할 수 있습니다.

  봇이 응답하고 있는 스레드에서 `new` 를 텍스트로 입력해주세요.
  프롬프트를 함께 전달하려면: `new fix the bug`
  ```
- `/new` 자체는 스레드 컨텍스트 없이는 동작 불가 → 항상 fallback

### 4. Side Effects
- 없음

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| thread_ts 없음 (항상) | N/A | fallback 안내 메시지 |

### 6. Output
- Ephemeral: 스레드에서 텍스트 명령 사용 안내

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `new_alwaysReturnsFallbackMessage` | Happy Path | S5, Section 3b |
| `new_withPrompt_includesPromptInFallbackMessage` | Happy Path | S5, Section 3b |
| `new_respond_calledWithEphemeralType` | Contract | S5, Section 3b |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| `/session` 직접 핸들링 (CommandRouter 우회) | small | SessionHandler가 이미 ephemeral 로직 보유. CommandRouter 경유 시 text="sessions"로 매핑해야 하는데, 직접 호출이 더 명확 |
| `/new` 항상 fallback | small | SlashCommand에 thread_ts 없음 — bolt 타입으로 확인. workaround(최근 스레드 추측 등)은 위험 |
| 빈 `/soma` 입력 → help fallback | tiny | 자연스러운 UX, 5줄 분기 추가 |
| `respond()` → `SayFn` 래핑 어댑터 | small | 기존 CommandHandler가 `say()` 시그니처에 의존. 인터페이스 변경보다 어댑터가 switching cost 낮음 |

## Implementation Status

| Scenario | Size | Trace | Tests | Status |
|----------|------|-------|-------|--------|
| 1. Manifest & EventRouter Registration | medium | done | GREEN (11/11) | Complete |
| 2. /soma with Valid Subcommand | small | done | GREEN | Complete |
| 3. /soma with Empty/Unknown Subcommand | small | done | GREEN | Complete |
| 4. /session Ephemeral Session List | small | done | GREEN | Complete |
| 5. /new Thread Context Fallback | tiny | done | GREEN | Complete |

## Next Step

→ Proceed with implementation + Trace Verify via `stv:work docs/slash-commands/trace.md`
