# Admin Commands — Vertical Trace

> STV Trace | Created: 2026-03-06
> Spec: docs/admin-commands/spec.md

## Table of Contents

1. [Scenario 1 — Existing User Migration](#scenario-1--existing-user-migration)
2. [Scenario 2 — New User Acceptance Gate](#scenario-2--new-user-acceptance-gate)
3. [Scenario 3 — Pending User Re-message](#scenario-3--pending-user-re-message)
4. [Scenario 4 — Admin Accept via Button](#scenario-4--admin-accept-via-button)
5. [Scenario 5 — Admin Deny via Button](#scenario-5--admin-deny-via-button)
6. [Scenario 6 — Accept Command](#scenario-6--accept-command)
7. [Scenario 7 — Deny Command](#scenario-7--deny-command)
8. [Scenario 8 — Users Command](#scenario-8--users-command)
9. [Scenario 9 — Config Show](#scenario-9--config-show)
10. [Scenario 10 — Config Set](#scenario-10--config-set)

---

## Scenario 1 — Existing User Migration

기존 user-settings.json에 `accepted` 필드가 없는 레코드에 `accepted: true` 자동 설정.

### 1.1 ASCII Diagram

```
 App Start / Settings Load
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  UserSettingsStore.loadSettings()                    │
 │  src/user-settings-store.ts                         │
 │                                                     │
 │  Step 1: Read user-settings.json from disk          │
 │  Step 2: For each user record:                      │
 │    if (record.accepted === undefined)                │
 │      → record.accepted = true  (grandfathering)     │
 │      → didUpdate = true                             │
 │  Step 3: if (didUpdate) saveSettings()              │
 │                                                     │
 │  Invariants:                                        │
 │    - All existing records get accepted=true          │
 │    - New records created without accepted field      │
 │      are never left in undefined state               │
 └─────────────────────────────────────────────────────┘
```

### 1.2 Data Model

```typescript
interface UserSettings {
  // existing fields...
  accepted: boolean;        // NEW: default true for existing, false for new pending
  acceptedBy?: string;      // admin userId who accepted
  acceptedAt?: string;      // ISO timestamp
}
```

### 1.3 Error Paths

| Condition | Error | Behavior |
|-----------|-------|----------|
| JSON parse failure | Logged, settings = {} | Existing behavior |

### 1.4 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `migration: adds accepted=true to existing records` | Side-Effect | Step 2 |
| `migration: preserves existing accepted field` | Invariant | Step 2 |
| `migration: new UserSettings has accepted=false by default` | Contract | ensureUserExists |

---

## Scenario 2 — New User Acceptance Gate

신규 유저가 처음 메시지를 보내면 "승인 대기 중" 메시지 표시 + admin에게 DM 알림.

### 2.1 ASCII Diagram

```
 New User Message (Slack)
       │
       │  event: { user: "U_NEW", text: "hello", channel: "C123" }
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  SessionInitializer.initialize()                    │
 │  src/slack/pipeline/session-initializer.ts          │
 │                                                     │
 │  Step 1: createSession(user, userName, channel, ts) │
 │  Step 2: userSettingsStore.getUserSettings(user)     │
 │    → returns undefined (first-time user)            │
 │                                                     │
 │  Step 3: [NEW] Acceptance gate check                │
 │    → userSettingsStore.createPendingUser(user, name) │
 │    → creates { accepted: false, ... }               │
 │                                                     │
 │  Step 4: Post "승인 대기 중" message to thread      │
 │    say({ text: "승인 대기 중...", thread_ts })       │
 │                                                     │
 │  Step 5: Send admin DM with Accept/Deny buttons     │
 │    → notifyAdminsNewUser(userId, userName)           │
 │    → for each admin in ADMIN_USERS:                 │
 │        slackApi.postMessage(admin, blocks)           │
 │                                                     │
 │  Step 6: return (do NOT proceed to onboarding)      │
 │                                                     │
 │  Side-Effects:                                      │
 │    INSERT user-settings.json { accepted: false }    │
 │    POST Slack message to user thread                │
 │    POST Slack DM to each admin                      │
 │                                                     │
 │  Invariants:                                        │
 │    - No session/onboarding for unapproved user      │
 │    - Admin receives notification exactly once        │
 └─────────────────────────────────────────────────────┘
```

### 2.2 Admin DM Block Kit

```json
{
  "text": "New user access request",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "🆕 *New User Request*\n<@U_NEW> wants to use the bot"
      }
    },
    {
      "type": "actions",
      "block_id": "user_acceptance",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Accept" },
          "action_id": "accept_user",
          "value": "U_NEW",
          "style": "primary"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Deny" },
          "action_id": "deny_user",
          "value": "U_NEW",
          "style": "danger"
        }
      ]
    }
  ]
}
```

### 2.3 Error Paths

| Condition | Error | Behavior |
|-----------|-------|----------|
| No ADMIN_USERS configured | No admins to notify | Log warning, user stays pending |
| Slack DM post fails | API error | Log error, user still pending, can retry |

### 2.4 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `gate: blocks new user without settings` | Happy Path | Step 2-3 |
| `gate: creates pending user record` | Side-Effect | Step 3 |
| `gate: posts pending message to user` | Side-Effect | Step 4 |
| `gate: sends admin DM with buttons` | Side-Effect | Step 5 |
| `gate: does not proceed to onboarding` | Invariant | Step 6 |
| `gate: accepted user passes through normally` | Happy Path | acceptance check |

---

## Scenario 3 — Pending User Re-message

이미 pending 상태인 유저가 다시 메시지를 보냄.

### 3.1 ASCII Diagram

```
 Pending User Message (again)
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  SessionInitializer.initialize()                    │
 │  src/slack/pipeline/session-initializer.ts          │
 │                                                     │
 │  Step 1: userSettingsStore.getUserSettings(user)     │
 │    → returns { accepted: false, ... }               │
 │                                                     │
 │  Step 2: Post "아직 승인 대기 중" message           │
 │    say({ text: "아직 승인 대기 중...", thread_ts }) │
 │                                                     │
 │  Step 3: return (do NOT proceed)                    │
 │                                                     │
 │  Invariants:                                        │
 │    - No duplicate admin notifications               │
 │    - No session creation for pending user            │
 └─────────────────────────────────────────────────────┘
```

### 3.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `gate: blocks pending user with accepted=false` | Happy Path | Step 1-2 |
| `gate: does not re-notify admins` | Invariant | Step 2 |

---

## Scenario 4 — Admin Accept via Button

Admin이 DM의 Accept 버튼을 클릭.

### 4.1 ASCII Diagram

```
 Admin clicks "Accept" button in DM
       │
       │  action: { action_id: "accept_user", value: "U_NEW" }
       │  body.user.id: "U_ADMIN"
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  UserAcceptanceActionHandler.handleAccept()         │
 │  src/slack/actions/user-acceptance-action-handler.ts │
 │                                                     │
 │  Step 1: Extract userId from action value           │
 │    targetUser = body.actions[0].value  ("U_NEW")    │
 │    adminUser = body.user.id  ("U_ADMIN")            │
 │                                                     │
 │  Step 2: Verify admin                               │
 │    if (!isAdminUser(adminUser)) → reject            │
 │                                                     │
 │  Step 3: Accept the user                            │
 │    userSettingsStore.acceptUser(targetUser, admin)   │
 │    → sets accepted=true, acceptedBy, acceptedAt     │
 │                                                     │
 │  Step 4: Update the admin DM message                │
 │    respond({ text: "✅ Accepted", replace: true })  │
 │                                                     │
 │  Step 5: Notify the user via DM                     │
 │    slackApi.postMessage(targetUser,                 │
 │      "✅ 사용이 승인되었습니다! 메시지를 보내세요.") │
 │                                                     │
 │  Side-Effects:                                      │
 │    UPDATE user-settings.json                        │
 │      { accepted: true, acceptedBy, acceptedAt }     │
 │    UPDATE admin DM message (replace original)       │
 │    POST DM to accepted user                         │
 └─────────────────────────────────────────────────────┘
```

### 4.2 Error Paths

| Condition | Error | Behavior |
|-----------|-------|----------|
| Non-admin clicks button | Unauthorized | Respond ephemeral error |
| User already accepted | Idempotent | Respond "already accepted" |
| Target user not found | Invalid | Respond error message |

### 4.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `accept-button: sets accepted=true` | Side-Effect | Step 3 |
| `accept-button: updates admin DM` | Side-Effect | Step 4 |
| `accept-button: notifies user` | Side-Effect | Step 5 |
| `accept-button: rejects non-admin` | Sad Path | Step 2 |
| `accept-button: idempotent for already-accepted` | Invariant | Error path |

---

## Scenario 5 — Admin Deny via Button

Admin이 DM의 Deny 버튼을 클릭.

### 5.1 ASCII Diagram

```
 Admin clicks "Deny" button in DM
       │
       │  action: { action_id: "deny_user", value: "U_NEW" }
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  UserAcceptanceActionHandler.handleDeny()            │
 │  src/slack/actions/user-acceptance-action-handler.ts │
 │                                                     │
 │  Step 1: Extract userId + verify admin              │
 │  Step 2: Remove user settings record                │
 │    userSettingsStore.removeUserSettings(targetUser)  │
 │  Step 3: Update admin DM                            │
 │    respond({ text: "❌ Denied", replace: true })    │
 │  Step 4: Notify user via DM                         │
 │    slackApi.postMessage(targetUser,                 │
 │      "❌ 사용 요청이 거부되었습니다.")               │
 │                                                     │
 │  Side-Effects:                                      │
 │    DELETE from user-settings.json                   │
 │    UPDATE admin DM message                          │
 │    POST DM to denied user                           │
 └─────────────────────────────────────────────────────┘
```

### 5.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `deny-button: removes user settings` | Side-Effect | Step 2 |
| `deny-button: updates admin DM` | Side-Effect | Step 3 |
| `deny-button: notifies denied user` | Side-Effect | Step 4 |
| `deny-button: rejects non-admin` | Sad Path | Step 1 |

---

## Scenario 6 — Accept Command

Admin이 `accept @user` 명령어 실행.

### 6.1 ASCII Diagram

```
 Admin types: "accept <@U_NEW>"
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  CommandRouter.route()                              │
 │  src/slack/commands/command-router.ts               │
 │    → AdminHandler.canHandle("accept <@U_NEW>")      │
 │    → true                                           │
 │    → AdminHandler.execute(ctx)                      │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  AdminHandler.execute()                             │
 │  src/slack/commands/admin-handler.ts                │
 │                                                     │
 │  Step 1: isAdminUser(ctx.user) check                │
 │    → false: say("⛔ Admin only") + return           │
 │                                                     │
 │  Step 2: Parse command                              │
 │    CommandParser.parseAdminCommand(text)             │
 │    → { action: 'accept', targetUser: 'U_NEW' }     │
 │                                                     │
 │  Step 3: Extract user mention from Slack format     │
 │    "<@U_NEW>" → "U_NEW"                             │
 │                                                     │
 │  Step 4: userSettingsStore.acceptUser(target, admin) │
 │    → sets accepted=true, acceptedBy, acceptedAt     │
 │                                                     │
 │  Step 5: say("✅ <@U_NEW> 승인 완료")              │
 │                                                     │
 │  Step 6: slackApi.postMessage(target,               │
 │    "✅ 사용이 승인되었습니다!")                      │
 │                                                     │
 │  Side-Effects:                                      │
 │    UPDATE user-settings.json { accepted: true }     │
 │    POST Slack confirm message                       │
 │    POST DM to accepted user                         │
 └─────────────────────────────────────────────────────┘
```

### 6.2 Error Paths

| Condition | Error | Behavior |
|-----------|-------|----------|
| Non-admin user | "⛔ Admin only" | handled: true |
| No target user | "Usage: accept @user" | handled: true |
| User not found in settings | Creates + accepts | Auto-create accepted record |

### 6.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `accept-cmd: accepts pending user` | Happy Path | Step 4-5 |
| `accept-cmd: rejects non-admin` | Sad Path | Step 1 |
| `accept-cmd: extracts user from mention` | Contract | Step 3 |
| `accept-cmd: creates + accepts unknown user` | Side-Effect | Error path |

---

## Scenario 7 — Deny Command

Admin이 `deny @user` 명령어 실행.

### 7.1 ASCII Diagram

```
 Admin types: "deny <@U_NEW>"
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  AdminHandler.execute()                             │
 │  src/slack/commands/admin-handler.ts                │
 │                                                     │
 │  Step 1: isAdminUser check                          │
 │  Step 2: Parse → { action: 'deny', target: 'U_NEW'}│
 │  Step 3: userSettingsStore.removeUserSettings(user) │
 │  Step 4: say("❌ <@U_NEW> 거부됨")                 │
 │  Step 5: Post DM to denied user                    │
 │                                                     │
 │  Side-Effects:                                      │
 │    DELETE from user-settings.json                   │
 │    POST Slack messages                              │
 └─────────────────────────────────────────────────────┘
```

### 7.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `deny-cmd: removes user and confirms` | Happy Path | Step 3-4 |
| `deny-cmd: rejects non-admin` | Sad Path | Step 1 |

---

## Scenario 8 — Users Command

Admin이 `users` 명령어로 유저 목록 확인.

### 8.1 ASCII Diagram

```
 Admin types: "users"
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  AdminHandler.execute()                             │
 │  src/slack/commands/admin-handler.ts                │
 │                                                     │
 │  Step 1: isAdminUser check                          │
 │  Step 2: Parse → { action: 'users' }               │
 │  Step 3: Get all user settings                      │
 │    const allUsers = userSettingsStore.getAllUsers()  │
 │                                                     │
 │  Step 4: Partition by accepted status               │
 │    accepted = users.filter(u => u.accepted)         │
 │    pending = users.filter(u => !u.accepted)         │
 │                                                     │
 │  Step 5: Format and display                         │
 │    "👥 *Users* (N total)\n"                         │
 │    "*Pending (N):*\n"                               │
 │    "• <@U1> — since {date}\n"                       │
 │    "*Accepted (N):*\n"                              │
 │    "• <@U2> — accepted by <@ADMIN> on {date}\n"    │
 │                                                     │
 │  say({ text: formatted, thread_ts })                │
 └─────────────────────────────────────────────────────┘
```

### 8.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `users-cmd: shows accepted and pending` | Happy Path | Step 3-5 |
| `users-cmd: rejects non-admin` | Sad Path | Step 1 |
| `users-cmd: handles empty user list` | Happy Path | Step 5 |

---

## Scenario 9 — Config Show

Admin이 `config show` 명령어로 현재 .env 설정 표시.

### 9.1 ASCII Diagram

```
 Admin types: "config show"
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  AdminHandler.execute()                             │
 │  src/slack/commands/admin-handler.ts                │
 │                                                     │
 │  Step 1: isAdminUser check                          │
 │  Step 2: Parse → { action: 'config', sub: 'show' } │
 │                                                     │
 │  Step 3: Read .env file                             │
 │    fs.readFileSync(ENV_FILE, 'utf8')                │
 │    Parse each line: KEY=VALUE (skip comments/#)     │
 │                                                     │
 │  Step 4: Mask secrets                               │
 │    SENSITIVE_PATTERNS = /TOKEN|SECRET|KEY|PASSWORD|  │
 │      PRIVATE/i                                      │
 │    if (key matches pattern):                        │
 │      value = maskSecret(value)                      │
 │      // first 4 chars + "..." + last 4 chars        │
 │                                                     │
 │  Step 5: Format output                              │
 │    "⚙️ *Config* (`{ENV_FILE}`)\n\n"                 │
 │    "```\n"                                          │
 │    "KEY1=value1\n"                                  │
 │    "KEY2=abcd...wxyz\n"  (masked)                   │
 │    "```"                                            │
 │                                                     │
 │  say({ text: formatted, thread_ts })                │
 └─────────────────────────────────────────────────────┘
```

### 9.2 Error Paths

| Condition | Error | Behavior |
|-----------|-------|----------|
| .env file not found | File read error | say("❌ .env file not found") |
| Empty .env file | No entries | say("Config is empty") |

### 9.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `config-show: displays all env vars` | Happy Path | Step 3-5 |
| `config-show: masks sensitive values` | Contract | Step 4 |
| `config-show: skips comments and empty lines` | Contract | Step 3 |
| `config-show: rejects non-admin` | Sad Path | Step 1 |
| `config-show: handles missing .env` | Sad Path | Error path |

---

## Scenario 10 — Config Set

Admin이 `config KEY=VALUE` 명령어로 설정 변경.

### 10.1 ASCII Diagram

```
 Admin types: "config DEBUG=true"
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  AdminHandler.execute()                             │
 │  src/slack/commands/admin-handler.ts                │
 │                                                     │
 │  Step 1: isAdminUser check                          │
 │  Step 2: Parse → { action: 'config',               │
 │           sub: 'set', key: 'DEBUG', value: 'true' } │
 │                                                     │
 │  Step 3: Update process.env                         │
 │    process.env[key] = value                         │
 │                                                     │
 │  Step 4: Update .env file                           │
 │    content = fs.readFileSync(ENV_FILE, 'utf8')      │
 │    if line starts with KEY=:                        │
 │      replace line with KEY=VALUE                    │
 │    else:                                            │
 │      append KEY=VALUE to end                        │
 │    fs.writeFileSync(ENV_FILE, content)              │
 │                                                     │
 │  Step 5: Reset special caches                       │
 │    CACHE_RESET_MAP = {                              │
 │      'ADMIN_USERS': () => resetAdminUsersCache(),   │
 │      'CLAUDE_CODE_OAUTH_TOKEN_LIST':                │
 │        () => tokenManager.initialize(),             │
 │    }                                                │
 │    if (CACHE_RESET_MAP[key]) CACHE_RESET_MAP[key]() │
 │                                                     │
 │  Step 6: Confirm                                    │
 │    say("✅ `KEY` updated to `VALUE`")               │
 │    if (cacheReset) say("🔄 Cache refreshed")        │
 │                                                     │
 │  Side-Effects:                                      │
 │    UPDATE process.env[KEY]                           │
 │    UPDATE .env file on disk                         │
 │    RESET cached values (if applicable)              │
 └─────────────────────────────────────────────────────┘
```

### 10.2 Error Paths

| Condition | Error | Behavior |
|-----------|-------|----------|
| Invalid format (no =) | Parse error | say("Usage: config KEY=VALUE") |
| .env write fails | IO error | say("⚠️ process.env updated but .env write failed") |
| Empty key | Validation | say("❌ Key cannot be empty") |

### 10.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `config-set: updates process.env` | Side-Effect | Step 3 |
| `config-set: updates .env file` | Side-Effect | Step 4 |
| `config-set: replaces existing key in .env` | Contract | Step 4 |
| `config-set: appends new key to .env` | Contract | Step 4 |
| `config-set: resets ADMIN_USERS cache` | Side-Effect | Step 5 |
| `config-set: resets token manager for CCT` | Side-Effect | Step 5 |
| `config-set: rejects non-admin` | Sad Path | Step 1 |
| `config-set: rejects invalid format` | Sad Path | Error path |
| `config-set: handles .env write failure` | Sad Path | Error path |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Action handler in `user-acceptance-action-handler.ts` | small | 기존 action handler 패턴 (permission-action-handler.ts) 답습 |
| `maskSecret()` 로직: 앞4 + ... + 뒤4 | tiny | 기존 `TokenManager.maskToken()` 패턴과 유사 |
| Deny 시 settings 삭제 (not soft-delete) | small | 재요청 시 다시 pending으로 생성됨, 복잡성 불필요 |
| Admin 명령어 regex: `/^\/?(?:accept\|deny)\s+<@(\w+)>/` | tiny | Slack mention 형식 파싱 |
| `config` 명령어 regex: `/^\/?config(?:\s+(.*))?$/` | tiny | 기존 패턴 답습 |
| `users` 명령어 regex: `/^\/?users$/` | tiny | 단순 키워드 매칭 |
| getAllUsers() 메서드 추가 | small | 기존 listUsers()를 확장, settings 객체 반환 |

## Implementation Status

| # | Scenario | Size | Trace | Tests | Verify | Status |
|---|----------|------|-------|-------|--------|--------|
| 1 | Existing User Migration | small | done | GREEN | Verified | Complete |
| 2 | New User Acceptance Gate | medium | done | GREEN | Verified | Complete |
| 3 | Pending User Re-message | small | done | GREEN | Verified | Complete |
| 4 | Admin Accept via Button | medium | done | GREEN | Verified | Complete |
| 5 | Admin Deny via Button | small | done | GREEN | Verified | Complete |
| 6 | Accept Command | small | done | GREEN | Verified | Complete |
| 7 | Deny Command | small | done | GREEN | Verified | Complete |
| 8 | Users Command | small | done | GREEN | Verified | Complete |
| 9 | Config Show | medium | done | GREEN | Verified | Complete |
| 10 | Config Set | medium | done | GREEN | Verified | Complete |

## Trace Deviations

- Scenario 2-3: Returns `halted: true` in `SessionInitResult` (reusing existing channel routing halt pattern) instead of custom `{ skipped, reason }` return. Terminates session after blocking to ensure next message also triggers the gate.
- Onboarding tests updated to reflect acceptance gate: new users without settings are now blocked (not auto-onboarded).

## Verified At

2026-03-06 — All 10 scenarios GREEN + Verified
