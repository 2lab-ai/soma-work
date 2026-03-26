# Turn Completion Notification System — Vertical Trace

> STV Trace | Created: 2026-03-24
> Spec: docs/turn-notification/spec.md
> GitHub Issue: [#69](https://github.com/2lab-ai/soma-work/issues/69)

## Table of Contents
1. [Scenario 1 — TurnNotifier 코어 + Slack Block Kit 시각적 알림](#scenario-1)
2. [Scenario 2 — Slack DM 알림 채널](#scenario-2)
3. [Scenario 3 — 웹훅 알림 채널 (등록 + 발송 + retry)](#scenario-3)
4. [Scenario 4 — 텔레그램 DM 알림 채널](#scenario-4)
5. [Scenario 5 — notify 커맨드 핸들러](#scenario-5)
6. [Scenario 6 — webhook 커맨드 핸들러](#scenario-6)

---

## Scenario 1 — TurnNotifier 코어 + Slack Block Kit 시각적 알림

> 턴 종료 시점에 카테고리를 판별하고, 스레드에 Block Kit 컬러 메시지를 게시하며, 등록된 모든 NotificationChannel에 fire-and-forget 발송.

### 1. API Entry
- Entry point: `StreamExecutor.execute()` 내부 (HTTP API 아님, 내부 파이프라인)
- Trigger: AI 스트림 처리 완료 직후 (L537 `setActivityState` 호출 후)
- Auth/AuthZ: 내부 호출이므로 별도 인증 불필요

### 2. Input
- 입력 파라미터:
  ```typescript
  interface TurnCompletionEvent {
    category: 'UIUserAskQuestion' | 'WorkflowComplete' | 'Exception';
    userId: string;           // session.ownerId
    channel: string;          // Slack channel ID
    threadTs: string;         // Slack thread timestamp
    sessionTitle?: string;    // session.title
    message?: string;         // 마지막 AI 메시지 요약
    durationMs: number;       // Date.now() - requestStartedAt.getTime()
  }
  ```
- 카테고리 판별 규칙:
  - `hasPendingChoice === true` → `UIUserAskQuestion`
  - `hasPendingChoice === false` (정상 완료) → `WorkflowComplete`
  - catch block 진입 → `Exception`

### 3. Layer Flow

#### 3a. StreamExecutor (Hook Point)
- 위치: `src/slack/pipeline/stream-executor.ts` L537 직후
- 파라미터 변환:
  - `hasPendingChoice` → `TurnCompletionEvent.category`
    - `true` → `'UIUserAskQuestion'`
    - `false` → `'WorkflowComplete'`
  - `session.ownerId` → `TurnCompletionEvent.userId`
  - `channel` → `TurnCompletionEvent.channel`
  - `threadTs` → `TurnCompletionEvent.threadTs`
  - `session.title` → `TurnCompletionEvent.sessionTitle`
  - `Date.now() - requestStartedAt.getTime()` → `TurnCompletionEvent.durationMs`
- Exception 경로: `handleError()` (L618) 내부에서도 동일 호출
  - `error` 발생 시 → `category: 'Exception'`

#### 3b. TurnNotifier Service
- 위치: `src/turn-notifier.ts` (신규)
- `notify(event: TurnCompletionEvent): Promise<void>`
  - UserSettingsStore에서 유저의 notification 설정 조회
  - 각 카테고리의 on/off 확인: `settings.notification?.categories?.[category] !== false`
  - 활성화된 NotificationChannel에 `Promise.allSettled()`로 병렬 발송
- 변환:
  - `TurnCompletionEvent.category` → Block Kit attachment color
    - `'UIUserAskQuestion'` → `'#FF9500'`
    - `'WorkflowComplete'` → `'#36B37E'`
    - `'Exception'` → `'#FF5630'`
  - `TurnCompletionEvent.category` → emoji
    - `'UIUserAskQuestion'` → `🟠`
    - `'WorkflowComplete'` → `🟢`
    - `'Exception'` → `🔴`

#### 3c. SlackBlockKitChannel (스레드 내 시각적 알림)
- 위치: `src/notification-channels/slack-block-kit-channel.ts` (신규)
- `send(event)` → `slackApi.postMessage(event.channel, text, { threadTs, blocks, attachments })`
- Block Kit 구조:
  ```json
  {
    "attachments": [{
      "color": "#FF9500",
      "blocks": [
        { "type": "section", "text": { "type": "mrkdwn", "text": "🟠 *유저 입력 대기*" }},
        { "type": "context", "elements": [
          { "type": "mrkdwn", "text": "세션: {sessionTitle} | 소요: {durationMs}ms" }
        ]}
      ]
    }]
  }
  ```

### 4. Side Effects
- Slack API 호출: `chat.postMessage` (스레드 내 Block Kit 메시지)
- DB 변경: 없음 (알림 자체는 상태를 저장하지 않음)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| Slack API rate limit | `slack_webapi_rate_limited` | SlackApiHelper 내장 rate limiter가 큐잉 |
| Slack API 실패 | 네트워크 에러 | `logger.warn()`, 무시 (fire-and-forget) |
| 유저 설정 없음 | notification 미설정 | 기본값 적용 (Block Kit만 발송, DM/webhook/telegram 미발송) |

### 6. Output
- Slack 스레드에 Block Kit attachment 메시지 게시됨
- 반환값: `void` (fire-and-forget)

### 7. Observability
- Log: `TurnNotifier.notify() category={category} userId={userId} channels=[slack,dm,webhook,telegram]`
- Log (실패 시): `TurnNotifier channel={name} failed error={message}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `TurnNotifier_categorizes_waiting_as_UIUserAskQuestion` | Contract | Scenario 1, Section 3a |
| `TurnNotifier_categorizes_idle_as_WorkflowComplete` | Contract | Scenario 1, Section 3a |
| `TurnNotifier_categorizes_error_as_Exception` | Contract | Scenario 1, Section 3a |
| `TurnNotifier_sends_to_all_enabled_channels` | Happy Path | Scenario 1, Section 3b |
| `TurnNotifier_skips_disabled_categories` | Sad Path | Scenario 1, Section 3b |
| `TurnNotifier_does_not_block_on_channel_failure` | Side-Effect | Scenario 1, Section 5 |
| `SlackBlockKit_maps_category_to_correct_color` | Contract | Scenario 1, Section 3b→3c |

---

## Scenario 2 — Slack DM 알림 채널

> `notify on` 활성화 시, 턴 종료 시 유저에게 Slack DM으로 알림 전송.

### 1. API Entry
- Entry: `TurnNotifier.notify()` → `SlackDmChannel.send()`
- Auth: Slack Bot Token (이미 사용 중)

### 2. Input
- `TurnCompletionEvent` 전체
- `userSettings.notification.slackDm === true` 일 때만 활성화

### 3. Layer Flow

#### 3a. SlackDmChannel
- 위치: `src/notification-channels/slack-dm-channel.ts` (신규)
- `isEnabled(userId)`:
  - `userSettingsStore.getUserSettings(userId)?.notification?.slackDm === true`
- `send(event)`:
  1. `slackApi.app.client.conversations.open({ users: event.userId })` → `dmChannelId`
  2. `slackApi.postMessage(dmChannelId, text, { blocks })`
- 변환:
  - `event.channel` + `event.threadTs` → Slack 스레드 permalink
    - `https://slack.com/archives/{channel}/p{threadTs(dots removed)}`
  - `event.category` → DM 메시지 텍스트
    - `'UIUserAskQuestion'` → `"🟠 입력이 필요합니다 — {sessionTitle}"`
    - `'WorkflowComplete'` → `"🟢 작업 완료 — {sessionTitle}"`
    - `'Exception'` → `"🔴 오류 발생 — {sessionTitle}"`

#### 3b. SlackApiHelper (확장)
- `openDmChannel(userId: string): Promise<string>` 메서드 추가
- `conversations.open({ users })` → `channel.id` 반환

### 4. Side Effects
- Slack API 호출: `conversations.open` + `chat.postMessage` (DM 채널)

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| DM 채널 열기 실패 | `conversations.open` 에러 | `logger.warn()`, 건너뜀 |
| 유저가 봇 DM 차단 | `not_allowed_to_dm` | `logger.warn()`, 건너뜀 |

### 6. Output
- 유저 DM에 카테고리별 알림 메시지 + 스레드 링크

### 7. Observability
- Log: `SlackDmChannel.send() userId={userId} category={category}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `SlackDm_sends_dm_when_enabled` | Happy Path | Scenario 2, Section 3a |
| `SlackDm_skips_when_disabled` | Sad Path | Scenario 2, Section 3a |
| `SlackDm_opens_conversation_then_posts` | Contract | Scenario 2, Section 3a→3b |
| `SlackDm_handles_dm_blocked_gracefully` | Sad Path | Scenario 2, Section 5 |

---

## Scenario 3 — 웹훅 알림 채널 (등록 + 발송 + retry)

> 유저가 등록한 URL로 턴 종료 이벤트를 HTTP POST, 실패 시 exponential backoff로 3회 retry.

### 1. API Entry
- Entry: `TurnNotifier.notify()` → `WebhookChannel.send()`
- Auth: 없음 (유저 지정 URL로 POST)

### 2. Input
- `TurnCompletionEvent` 전체
- `userSettings.notification.webhookUrl` 존재 시 활성화

### 3. Layer Flow

#### 3a. WebhookChannel
- 위치: `src/notification-channels/webhook-channel.ts` (신규)
- `isEnabled(userId)`:
  - `Boolean(userSettingsStore.getUserSettings(userId)?.notification?.webhookUrl)`
- `send(event)`:
  - URL: `settings.notification.webhookUrl`
  - Method: `POST`
  - Headers: `{ 'Content-Type': 'application/json' }`
  - 변환 — `TurnCompletionEvent` → Webhook Payload:
    - `event.category` → `payload.event` (카테고리명 그대로)
    - `event.userId` → `payload.userId`
    - `event.channel` + `event.threadTs` → `payload.sessionId` (`${channel}-${threadTs}`)
    - `event.message` → `payload.message`
    - `new Date().toISOString()` → `payload.timestamp`

#### 3b. Retry Logic
- 최대 3회 시도
- Backoff: `delay = 1000 * 2^(attempt-1)` ms
  - attempt 1: 즉시
  - attempt 2: 1000ms 후
  - attempt 3: 2000ms 후 (note: 2^1 = 2, but capped at 4s as per spec. Actually: 2^0=1s, 2^1=2s, 2^2=4s)
    Correction: attempt 1 즉시, retry 1: 1s, retry 2: 4s (base 1s * 2^retryIndex)
- 타임아웃: 5000ms per request
- 모든 시도 실패 시: `logger.warn()`, 다음 이벤트에서 자연 재시도

### 4. Side Effects
- HTTP POST: 유저 지정 외부 URL
- DB 변경: 없음

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| URL 접근 불가 | `ECONNREFUSED` / `ETIMEDOUT` | retry (최대 3회) |
| HTTP 4xx | 클라이언트 에러 | retry 안 함 (4xx는 영구 실패) |
| HTTP 5xx | 서버 에러 | retry |
| URL 형식 오류 | `TypeError: Invalid URL` | 등록 시점에 검증, 발송 시 `logger.warn()` |

### 6. Output
- 외부 URL에 JSON payload POST 됨
- 반환값: `void`

### 7. Observability
- Log: `WebhookChannel.send() url={url} attempt={n} status={statusCode}`
- Log (실패): `WebhookChannel.send() FAILED after 3 attempts url={url}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `Webhook_posts_payload_to_registered_url` | Happy Path | Scenario 3, Section 3a |
| `Webhook_skips_when_no_url_registered` | Sad Path | Scenario 3, Section 3a |
| `Webhook_retries_on_5xx_with_backoff` | Side-Effect | Scenario 3, Section 3b |
| `Webhook_does_not_retry_on_4xx` | Sad Path | Scenario 3, Section 5 |
| `Webhook_payload_matches_spec_schema` | Contract | Scenario 3, Section 3a |
| `Webhook_respects_5s_timeout` | Side-Effect | Scenario 3, Section 3b |

---

## Scenario 4 — 텔레그램 DM 알림 채널

> 유저가 등록한 텔레그램 chat ID로 Bot API를 통해 턴 종료 DM 전송.

### 1. API Entry
- Entry: `TurnNotifier.notify()` → `TelegramChannel.send()`
- Auth: Telegram Bot Token (환경변수 `TELEGRAM_BOT_TOKEN`)

### 2. Input
- `TurnCompletionEvent` 전체
- `userSettings.notification.telegramChatId` 존재 시 활성화

### 3. Layer Flow

#### 3a. TelegramChannel
- 위치: `src/notification-channels/telegram-channel.ts` (신규)
- `isEnabled(userId)`:
  - `Boolean(process.env.TELEGRAM_BOT_TOKEN && userSettingsStore.getUserSettings(userId)?.notification?.telegramChatId)`
- `send(event)`:
  - Telegram Bot API: `POST https://api.telegram.org/bot{TOKEN}/sendMessage`
  - 변환:
    - `settings.notification.telegramChatId` → `payload.chat_id`
    - `event.category` + `event.sessionTitle` → `payload.text`
      - `"🟠 [soma-work] 입력 대기: {sessionTitle}\nhttps://slack.com/archives/{channel}/p{threadTs}"`
    - `'Markdown'` → `payload.parse_mode`

### 4. Side Effects
- HTTP POST: Telegram Bot API (`sendMessage`)
- DB 변경: 없음

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| 봇 토큰 미설정 | `TELEGRAM_BOT_TOKEN` 없음 | 채널 비활성화 (`isEnabled` false) |
| chat_id 잘못됨 | Telegram API 400 | `logger.warn()`, 건너뜀 |
| 유저가 봇 차단 | Telegram API 403 | `logger.warn()`, 건너뜀 |
| API 타임아웃 | 네트워크 에러 | `logger.warn()`, 건너뜀 (retry 없음 — 텔레그램은 신뢰도 높음) |

### 6. Output
- 텔레그램 DM으로 알림 메시지 전송됨

### 7. Observability
- Log: `TelegramChannel.send() chatId={chatId} category={category}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `Telegram_sends_message_when_configured` | Happy Path | Scenario 4, Section 3a |
| `Telegram_skips_when_no_token` | Sad Path | Scenario 4, Section 5 |
| `Telegram_skips_when_no_chatId` | Sad Path | Scenario 4, Section 3a |
| `Telegram_handles_blocked_user_gracefully` | Sad Path | Scenario 4, Section 5 |
| `Telegram_message_includes_thread_link` | Contract | Scenario 4, Section 3a |

---

## Scenario 5 — notify 커맨드 핸들러

> `notify on/off/status/telegram <id>` 텍스트 커맨드를 파싱하고 UserSettings에 저장.

### 1. API Entry
- Entry: Slack 메시지 → `CommandParser.isNotifyCommand()` → `CommandRouter` → `NotifyHandler.execute()`
- Auth: 봇에 메시지를 보낸 Slack 유저 (ctx.user)

### 2. Input
- 커맨드 텍스트 파싱:
  ```
  "notify on"                    → { type: 'notify', action: 'on' }
  "notify off"                   → { type: 'notify', action: 'off' }
  "notify status"                → { type: 'notify', action: 'status' }
  "notify telegram @chatId123"   → { type: 'notify', action: 'telegram', value: '@chatId123' }
  "notify telegram off"          → { type: 'notify', action: 'telegram_off' }
  ```

### 3. Layer Flow

#### 3a. CommandParser (수정)
- 위치: `src/slack/command-parser.ts`
- 추가 메서드:
  - `static isNotifyCommand(text: string): boolean`
    - regex: `/^notify\s/i`
  - `static parseNotifyCommand(text: string): NotifyCommandResult`
    - regex: `/^notify\s+(on|off|status|telegram)\s*(.*)$/i`
- COMMAND_KEYWORDS에 `'notify'` 추가 (L506)

#### 3b. NotifyHandler (신규)
- 위치: `src/slack/commands/notify-handler.ts`
- `canHandle(text)` → `CommandParser.isNotifyCommand(text)`
- `execute(ctx)`:
  - `action === 'on'`:
    - `userSettingsStore.patchNotification(ctx.user, { slackDm: true })`
    - 응답: `"✅ Slack DM 알림이 활성화되었습니다."`
  - `action === 'off'`:
    - `userSettingsStore.patchNotification(ctx.user, { slackDm: false })`
    - 응답: `"✅ Slack DM 알림이 비활성화되었습니다."`
  - `action === 'status'`:
    - 현재 설정 조회 → 포맷된 상태 메시지
  - `action === 'telegram'`:
    - `userSettingsStore.patchNotification(ctx.user, { telegramChatId: value })`
    - 응답: `"✅ 텔레그램 알림이 등록되었습니다. Chat ID: {value}"`
  - `action === 'telegram_off'`:
    - `userSettingsStore.patchNotification(ctx.user, { telegramChatId: undefined })`
    - 응답: `"✅ 텔레그램 알림이 해제되었습니다."`

#### 3c. UserSettingsStore (수정)
- `patchNotification(userId, patch: Partial<NotificationSettings>): void`
  - 기존 `patchUserSettings` 패턴 동일
  - `settings.notification = { ...settings.notification, ...patch }`

### 4. Side Effects
- File I/O: `data/user-settings.json` 갱신
- Slack API: `say()` 응답 메시지

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| 파싱 실패 (잘못된 인자) | 알 수 없는 action | 사용법 안내 메시지 반환 |
| 설정 파일 쓰기 실패 | fs.writeFile 에러 | `logger.error()`, 에러 메시지 응답 |

### 6. Output
- Slack 메시지로 설정 변경 확인 또는 현재 상태 표시

### 7. Observability
- Log: `NotifyHandler.execute() user={userId} action={action}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `NotifyCmd_on_enables_slack_dm` | Happy Path | Scenario 5, Section 3b |
| `NotifyCmd_off_disables_slack_dm` | Happy Path | Scenario 5, Section 3b |
| `NotifyCmd_status_shows_current_settings` | Happy Path | Scenario 5, Section 3b |
| `NotifyCmd_telegram_registers_chatId` | Happy Path | Scenario 5, Section 3b |
| `NotifyCmd_telegram_off_removes_chatId` | Happy Path | Scenario 5, Section 3b |
| `NotifyCmd_invalid_action_shows_usage` | Sad Path | Scenario 5, Section 5 |
| `NotifyCmd_persists_to_user_settings_json` | Side-Effect | Scenario 5, Section 4 |

---

## Scenario 6 — webhook 커맨드 핸들러

> `webhook register/remove/test` 커맨드를 파싱하고 UserSettings에 URL 저장.

### 1. API Entry
- Entry: Slack 메시지 → `CommandParser.isWebhookCommand()` → `CommandRouter` → `WebhookHandler.execute()`
- Auth: 봇에 메시지를 보낸 Slack 유저 (ctx.user)

### 2. Input
- 커맨드 텍스트 파싱:
  ```
  "webhook register https://example.com/hook" → { type: 'webhook', action: 'register', url: 'https://...' }
  "webhook remove"                             → { type: 'webhook', action: 'remove' }
  "webhook test"                               → { type: 'webhook', action: 'test' }
  ```

### 3. Layer Flow

#### 3a. CommandParser (수정)
- 추가 메서드:
  - `static isWebhookCommand(text: string): boolean`
    - regex: `/^webhook\s/i`
  - `static parseWebhookCommand(text: string): WebhookCommandResult`
    - regex: `/^webhook\s+(register|remove|test)\s*(.*)$/i`
- COMMAND_KEYWORDS에 `'webhook'` 추가

#### 3b. WebhookHandler (신규)
- 위치: `src/slack/commands/webhook-handler.ts`
- `canHandle(text)` → `CommandParser.isWebhookCommand(text)`
- `execute(ctx)`:
  - `action === 'register'`:
    - URL 검증: `new URL(url)` — 실패 시 에러 메시지
    - `userSettingsStore.patchNotification(ctx.user, { webhookUrl: url })`
    - 응답: `"✅ 웹훅이 등록되었습니다: {url}"`
  - `action === 'remove'`:
    - `userSettingsStore.patchNotification(ctx.user, { webhookUrl: undefined })`
    - 응답: `"✅ 웹훅이 삭제되었습니다."`
  - `action === 'test'`:
    - 등록된 URL에 테스트 페이로드 POST
    - 성공: `"✅ 테스트 웹훅 발송 성공 (HTTP {status})"`
    - 실패: `"❌ 테스트 웹훅 실패: {error}"`

### 4. Side Effects
- File I/O: `data/user-settings.json` 갱신
- HTTP POST (test 시): 유저 등록 URL로 테스트 페이로드
- Slack API: `say()` 응답 메시지

### 5. Error Paths
| Condition | Error | Handling |
|-----------|-------|----------|
| URL 형식 오류 | `TypeError: Invalid URL` | `"❌ 올바른 URL을 입력하세요"` 메시지 |
| register 시 URL 누락 | 빈 인자 | 사용법 안내 메시지 |
| test 시 URL 미등록 | webhookUrl 없음 | `"❌ 등록된 웹훅이 없습니다. 먼저 webhook register <url>"` |
| test 시 POST 실패 | 네트워크 에러 | `"❌ 테스트 실패: {error}"` |

### 6. Output
- Slack 메시지로 등록/삭제/테스트 결과 표시

### 7. Observability
- Log: `WebhookHandler.execute() user={userId} action={action} url={url}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `WebhookCmd_register_saves_valid_url` | Happy Path | Scenario 6, Section 3b |
| `WebhookCmd_register_rejects_invalid_url` | Sad Path | Scenario 6, Section 5 |
| `WebhookCmd_remove_clears_url` | Happy Path | Scenario 6, Section 3b |
| `WebhookCmd_test_posts_to_registered_url` | Happy Path | Scenario 6, Section 3b |
| `WebhookCmd_test_fails_when_no_url` | Sad Path | Scenario 6, Section 5 |
| `WebhookCmd_persists_url_to_settings` | Side-Effect | Scenario 6, Section 4 |
| `WebhookCmd_register_url_maps_to_settings_webhookUrl` | Contract | Scenario 6, Section 3a→3c |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| NotificationChannel 인터페이스로 전략 패턴 | small | 3개 채널 독립 확장, 채널 추가 시 인터페이스 구현만 추가 |
| 웹훅 4xx는 retry 안 함 | tiny | 4xx는 영구 실패 (잘못된 URL/페이로드), retry 무의미 |
| 텔레그램은 retry 없음 | tiny | 텔레그램 API 자체 신뢰도 높음, fire-and-forget으로 충분 |
| Block Kit 알림은 기본 활성화 (opt-out 아님, 항상 표시) | small | 스레드 내 시각적 피드백은 핵심 UX, 비활성화 옵션 불필요 |
| DM/Webhook/Telegram은 기본 비활성화 (opt-in) | small | 사용자가 명시적으로 등록해야 외부 알림 수신 |
| `notify`와 `webhook`을 별도 커맨드로 분리 | small | 단일 `notify` 커맨드에 모두 넣으면 파싱이 복잡해짐 |
| 환경변수 `TELEGRAM_BOT_TOKEN` | tiny | 봇 토큰은 런타임 설정, config.json보다 환경변수가 보안상 적합 |
| `notification-channels/` 디렉토리에 채널 구현체 분리 | small | 관심사 분리, 각 채널 독립 테스트 가능 |

## Implementation Status

| # | Scenario | Size | Trace | Tests | Status |
|---|----------|------|-------|-------|--------|
| 1 | TurnNotifier 코어 + Block Kit 시각적 알림 | medium | done | 7/7 GREEN | ✅ Complete |
| 2 | Slack DM 알림 채널 | small | done | 4/4 GREEN | ✅ Complete |
| 3 | 웹훅 알림 채널 (등록 + 발송 + retry) | medium | done | 6/6 GREEN | ✅ Complete |
| 4 | 텔레그램 DM 알림 채널 | small | done | 5/5 GREEN | ✅ Complete |
| 5 | notify 커맨드 핸들러 | small | done | 7/7 GREEN | ✅ Complete |
| 6 | webhook 커맨드 핸들러 | small | done | 7/7 GREEN | ✅ Complete |
|   | **Total** | **large** | | **36/36 GREEN** | **✅ All Complete** |

## File Map

### 신규 파일
| File | Scenario |
|------|----------|
| `src/turn-notifier.ts` | 1 |
| `src/notification-channels/slack-block-kit-channel.ts` | 1 |
| `src/notification-channels/slack-dm-channel.ts` | 2 |
| `src/notification-channels/webhook-channel.ts` | 3 |
| `src/notification-channels/telegram-channel.ts` | 4 |
| `src/slack/commands/notify-handler.ts` | 5 |
| `src/slack/commands/webhook-handler.ts` | 6 |

### 수정 파일
| File | Scenario | 변경 내용 |
|------|----------|----------|
| `src/slack/pipeline/stream-executor.ts` | 1 | L537 직후 + handleError 내 TurnNotifier 호출 |
| `src/user-settings-store.ts` | 5, 6 | notification 필드 + patchNotification() |
| `src/slack/command-parser.ts` | 5, 6 | isNotifyCommand/isWebhookCommand + COMMAND_KEYWORDS |
| `src/slack/commands/command-router.ts` | 5, 6 | NotifyHandler/WebhookHandler 등록 |
| `src/slack/slack-api-helper.ts` | 2 | openDmChannel() 추가 |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work docs/turn-notification/trace.md`
