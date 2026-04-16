# Slack Integration Specification

## Version
- Document Version: 1.1
- Source File: `src/slack-handler.ts`, `src/slack/z/`
- Last Updated: 2026-04-16 (#506: `/z` Phase 1)

## 1. Overview

Slack Handler는 모든 Slack 이벤트를 수신하고 처리하는 핵심 컴포넌트입니다. Socket Mode를 사용하여 실시간 이벤트를 처리합니다.

## 2. Slack App Requirements

### 2.1 Required OAuth Scopes

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | @멘션 이벤트 수신 |
| `channels:history` | 채널 메시지 읽기 |
| `chat:write` | 메시지 전송 |
| `chat:write.public` | 공개 채널 메시지 전송 |
| `im:history` | DM 메시지 읽기 |
| `im:read` | DM 정보 조회 |
| `im:write` | DM 메시지 전송 |
| `users:read` | 사용자 정보 조회 |
| `reactions:read` | 리액션 조회 |
| `reactions:write` | 리액션 추가/제거 |
| `files:read` | 파일 정보 읽기 (implicit) |

### 2.2 Required Events

| Event | Trigger |
|-------|---------|
| `app_mention` | 봇이 @멘션되었을 때 |
| `message.im` | DM 메시지 수신 |
| `member_joined_channel` | 봇이 채널에 추가되었을 때 |
| `message` | 일반 메시지 (스레드 컨텍스트 처리용) |

### 2.3 Socket Mode

```typescript
const app = new App({
  token: config.slack.botToken,       // xoxb-...
  signingSecret: config.slack.signingSecret,
  socketMode: true,
  appToken: config.slack.appToken,    // xapp-...
});
```

## 3. Event Handlers

### 3.1 Direct Message Handler

**Trigger**: `message.im` 이벤트 (DM 채널에서의 모든 메시지)

```typescript
this.app.message(async ({ message, say }) => {
  if (message.subtype === undefined && 'user' in message) {
    await this.handleMessage(message as MessageEvent, say);
  }
});
```

**특징**:
- @멘션 불필요
- 즉시 응답
- 사용자별 개별 세션

### 3.2 App Mention Handler

**Trigger**: `app_mention` 이벤트 (@클로드봇 형태로 멘션)

```typescript
this.app.event('app_mention', async ({ event, say }) => {
  const text = event.text.replace(/<@[^>]+>/g, '').trim();
  await this.handleMessage({
    ...event,
    text,
  } as MessageEvent, say);
});
```

**특징**:
- 채널에서 @멘션 필요
- 멘션 텍스트 제거 후 처리
- 스레드 컨텍스트 유지

### 3.3 Thread Message Handler

**Trigger**: 기존 세션이 있는 스레드에서의 메시지

```typescript
this.app.event('message', async ({ event, say }) => {
  // 봇 메시지 스킵
  if ('bot_id' in event || !('user' in event)) return;

  // 스레드 메시지 처리 (멘션 없이도)
  if (event.subtype === undefined && messageEvent.thread_ts) {
    const session = this.claudeHandler.getSession(channel, threadTs);
    if (session?.sessionId) {
      await this.handleMessage(messageEvent, say);
    }
  }
});
```

**특징**:
- 기존 세션이 있으면 @멘션 없이도 응답
- 새 대화는 @멘션 필요
- 파일 업로드도 처리

### 3.4 Channel Join Handler

**Trigger**: `member_joined_channel` 이벤트

```typescript
this.app.event('member_joined_channel', async ({ event, say }) => {
  if (event.user === await this.getBotUserId()) {
    await this.handleChannelJoin(event.channel, say);
  }
});
```

**환영 메시지 포맷**:
```
👋 Hi! I'm Claude Code, your AI coding assistant.

To get started, I need to know the default working directory for #channel-name.

You can use:
• `cwd project-name` (relative to base directory: `/path/to/base`)
• `cwd /absolute/path/to/project` (absolute path)

This becomes the default for all conversations in this channel.
```

## 4. Message Event Structure

### 4.1 MessageEvent Interface

```typescript
interface MessageEvent {
  user: string;           // Slack User ID (e.g., U1234567890)
  channel: string;        // Channel ID (e.g., C1234567890 or D1234567890)
  thread_ts?: string;     // Thread timestamp (parent message)
  ts: string;             // Message timestamp (unique ID)
  text?: string;          // Message text content
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}
```

### 4.2 Channel ID Patterns

| Pattern | Type | Example |
|---------|------|---------|
| `C*` | Public Channel | C01ABC23DEF |
| `D*` | Direct Message | D01ABC23DEF |
| `G*` | Private Channel/Group | G01ABC23DEF |

## 5. Response Handling

### 5.1 Status Messages

응답 진행 상태를 나타내는 메시지 업데이트:

```typescript
// 초기 상태
await say({ text: '🤔 *Thinking...*', thread_ts });

// 작업 중
await this.app.client.chat.update({
  channel,
  ts: statusMessageTs,
  text: '⚙️ *Working...*',
});

// 완료
await this.app.client.chat.update({
  channel,
  ts: statusMessageTs,
  text: '✅ *Task completed*',
});

// 오류
text: '❌ *Error occurred*'

// 취소
text: '⏹️ *Cancelled*'
```

### 5.2 Emoji Reactions

원본 메시지에 상태 이모지 추가:

| Emoji | Status | Code |
|-------|--------|------|
| 🤔 | Thinking | `thinking_face` |
| ⚙️ | Working | `gear` |
| ✅ | Completed | `white_check_mark` |
| ❌ | Error | `x` |
| 🛑 | Cancelled | `stop_sign` |
| 🔄 | In Progress (tasks) | `arrows_counterclockwise` |
| 📋 | Tasks Pending | `clipboard` |

```typescript
await this.app.client.reactions.add({
  channel: originalMessage.channel,
  timestamp: originalMessage.ts,
  name: 'white_check_mark',
});
```

### 5.3 Tool Output Formatting

**Edit Tool**:
```
📝 *Editing `path/to/file.ts`*

```diff
- old code here
+ new code here
```
```

**Write Tool**:
```
📄 *Creating `path/to/file.ts`*
```
preview content
```
```

**Read Tool**:
```
👁️ *Reading `path/to/file.ts`*
```

**Bash Tool**:
```
🖥️ *Running command:*
```bash
npm run build
```
```

**Task Tool (subagent delegation)**:
```
🔧 Using Subagent: *Explorer*
model: *opus*
prompt: Find code related to routing panel changes
prompt_length: 41
```

**MCP Tool**:
```
🔌 *MCP: serverName → toolName*
*key:* `value`
```

## 6. Interactive Components

### 6.1 Permission Buttons

```typescript
const blocks = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🔐 *Permission Request*\n\nClaude wants to use: \`${tool_name}\``
    }
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✅ Approve" },
        style: "primary",
        action_id: "approve_tool",
        value: approvalId
      },
      {
        type: "button",
        text: { type: "plain_text", text: "❌ Deny" },
        style: "danger",
        action_id: "deny_tool",
        value: approvalId
      }
    ]
  }
];
```

### 6.2 Button Action Handlers

```typescript
// Approve handler
this.app.action('approve_tool', async ({ ack, body, respond }) => {
  await ack();
  const approvalId = (body as any).actions[0].value;
  await sharedStore.storePermissionResponse(approvalId, {
    behavior: 'allow',
    message: 'Approved by user'
  });
});

// Deny handler
this.app.action('deny_tool', async ({ ack, body, respond }) => {
  await ack();
  const approvalId = (body as any).actions[0].value;
  await sharedStore.storePermissionResponse(approvalId, {
    behavior: 'deny',
    message: 'Denied by user'
  });
});
```

## 7. Error Handling

### 7.1 Message Error Recovery

```typescript
try {
  // Message processing
} catch (error: any) {
  if (error.name !== 'AbortError') {
    await say({
      text: `Error: ${error.message || 'Something went wrong'}`,
      thread_ts: thread_ts || ts,
    });
  }
}
```

### 7.2 Slack API Error Handling

```typescript
try {
  await this.app.client.chat.update({ ... });
} catch (error) {
  this.logger.warn('Failed to update message, creating new one', error);
  await this.createNewMessage(...);
}
```

## 8. Rate Limiting Considerations

- Slack API Rate Limits: ~1 request/second per method
- 상태 메시지 업데이트 최적화
- 동일 리액션 중복 추가 방지
- 배치 처리 가능한 작업 그룹화

## 9. Security

### 9.1 Request Verification

- Signing Secret으로 요청 검증
- Socket Mode로 안전한 연결

### 9.2 Token Security

- Bot Token: 환경변수로 관리
- App Token: 환경변수로 관리
- 파일 다운로드 시 Bot Token 사용

## 10. `/z` Unified Command Surface (Phase 1 — #506)

### 10.1 Entry Points

세 경로가 모두 동일한 `ZInvocation`으로 정규화된다:

| Source | 트리거 | respond 구현 |
|--------|--------|--------------|
| `slash` | `/z <topic>` Slack 슬래시 커맨드 | `SlashZRespond` (`respond()` + `response_url`) |
| `channel_mention` | `@bot /z <topic>` — app_mention | `ChannelEphemeralZRespond` (`chat.postEphemeral`) |
| `dm` | DM 메시지 본문 `/z <topic>` | `DmZRespond` (`chat.postMessage` + `chat.update` with branded `BotMessageTs`) |

### 10.2 Dispatch Pipeline

`src/slack/z/` 모듈:

1. **normalize** (`normalize.ts`) — entry text → `ZInvocation` + 플래그 (`isLegacyNaked`, `whitelistedNaked`).
2. **tombstone** (`tombstone.ts`) — legacy naked 감지. 매칭되면 `migrationHintShown` CAS로 한 번만 힌트 카드 표시.
3. **whitelist** (`whitelist.ts`) — `session`, `sessions public`, `new`, `renew`, `theme`, `$*` — 네이키드 허용.
4. **capability** (`capability.ts`) — slash 엔트리에서 스레드 컨텍스트가 필요한 명령 (`new`, `close`, `renew`, `context`, `restore`, `link`, `compact`, `session:set:*`) 차단.
5. **router** (`router.ts`) — `translateToLegacy()`로 `/z <topic> <verb> …` → 기존 legacy 문법으로 브리지한 뒤 `CommandRouter`에 dispatch. Phase 2에서 handler 가 직접 `/z` 문법을 수용하도록 이관 예정.
6. **ui-builder** (`ui-builder.ts`) — `buildHelpCard`, `buildTombstoneCard` (결정적 `block_id = z_<topic>_<issuedAt>_<idx>`), `buildSettingCard` (Phase 2 #507 stub).

### 10.3 Legacy Naked Handling

- 멀티 워드 legacy 명령 (`persona set linus`, `show prompt`, `mcp list` 등) — 실행되지 않고 **사용자당 한 번** 마이그레이션 힌트만 표시 (`user-settings-store.markMigrationHintShown`, CAS).
- 화이트리스트 네이키드는 기존대로 동작.
- 정체 불명 입력은 통과 → Claude 대화로 전달.

### 10.4 Slash 금지 Capability

Slack 슬래시 커맨드는 스레드 컨텍스트가 없으므로 다음은 rejection 메시지로 거절한다 (`SLASH_FORBIDDEN_MESSAGE`):

`new`, `close`, `renew`, `context`, `restore`, `link`, `compact`, `session:set:model`, `session:set:verbosity`, `session:set:effort`, `session:set:thinking`, `session:set:thinking_summary`

DM / 채널-멘션에서는 문제 없이 동작.

### 10.5 롤백

세 단계 (빠른 → 느린):

1. `SOMA_ENABLE_LEGACY_SLASH=true` 환경 변수 — tombstone 비활성, legacy 네이키드 그대로 dispatch.
2. `git revert` + 재배포.
3. `slack-app-manifest.prev.json` + `scripts/slack-manifest-rollback.sh` — Slack 앱 설정 UI에서 `/z` 슬래시 커맨드 제거.

상세: `docs/ops/rollback-z-refactor.md`.

