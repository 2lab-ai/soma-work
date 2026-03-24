# User Profile Variable System — Vertical Trace

> STV Trace | Created: 2026-03-24
> Spec: docs/user-profile-variables/spec.md
> Status: Retroactive — implementation complete, tests missing

## Table of Contents
1. [Scenario 1 — Email Auto-Fetch on Session Start](#scenario-1)
2. [Scenario 2 — User Variable Substitution in Prompt](#scenario-2)
3. [Scenario 3 — Fallback When Email Unavailable](#scenario-3)
4. [Scenario 4 — Co-Authored-By in Workflow Commits](#scenario-4)

---

## Scenario 1 — Email Auto-Fetch on Session Start

### 1. Entry Point
- Trigger: Slack message received → `StreamExecutor.execute()`
- File: `src/slack/pipeline/stream-executor.ts:240`
- Auth: Slack user must be accepted (`isUserAccepted`)

### 2. Input
- `user`: string (Slack user ID, e.g., `U094E5L4A15`)
- Implicit: UserSettingsStore cache state

### 3. Layer Flow

#### 3a. StreamExecutor (Trigger)
- Check: `userSettingsStore.getUserEmail(user)` → `undefined` or `string`
- Branch: if `undefined` → proceed to fetch; if cached → skip
- Transformation: `user` (Slack ID) → `getUserProfile(user)` call

#### 3b. SlackApiHelper (Fetch)
- File: `src/slack/slack-api-helper.ts:192-209`
- Call: `this.enqueue(() => this.app.client.users.info({ user: userId }))`
- Rate limited via `enqueue()` pattern
- Extract: `result.user.profile.email` → `profile.email`
- Extract: `profile.display_name || result.user.real_name || result.user.name || userId` → `displayName`
- Return: `{ displayName: string, email?: string }`

#### 3c. UserSettingsStore (Persist)
- File: `src/user-settings-store.ts:245-248`
- Call: `setUserEmail(userId, email)` → `patchUserSettings(userId, { email })`
- `patchUserSettings` creates record with defaults if user doesn't exist
- Transformation: `profile.email` → `UserSettings.email` → `user-settings.json[userId].email`

### 4. Side Effects
- File write: `user-settings.json` updated with email field
- Log: `logger.info('Set user email', { userId, email })`

### 5. Error Paths
| Condition | Handling | Impact |
|-----------|----------|--------|
| Slack API failure | catch → `logger.debug(...)` | Email remains `undefined`, session continues |
| `users:read.email` scope missing | `profile.email` is `undefined` | No email stored, variable unresolved |
| User already has email cached | `getUserEmail()` returns truthy → skip | No API call made |

### 6. Output
- No direct output — side effect only (email cached in UserSettings)
- Session continues normally regardless of success/failure

### 7. Observability
- Log: `debug` on failure, `info` on successful email set
- No metrics/spans

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `should fetch and cache email on first session` | Happy Path | S1, Section 3a-3c |
| `should skip fetch when email already cached` | Happy Path | S1, Section 3a branch |
| `should handle Slack API failure gracefully` | Sad Path | S1, Section 5, row 1 |
| `should handle missing email scope gracefully` | Sad Path | S1, Section 5, row 2 |

---

## Scenario 2 — User Variable Substitution in Prompt

### 1. Entry Point
- Trigger: `PromptBuilder.buildSystemPrompt(userId, workflow)`
- File: `src/prompt-builder.ts:294`
- Called from: `ClaudeHandler` (`src/claude-handler.ts:517`)

### 2. Input
- `userId`: string (optional, Slack user ID)
- `workflow`: WorkflowType (e.g., `'jira-create-pr'`)
- Implicit: Prompt content containing `{{user.email}}`, `{{user.displayName}}` etc.

### 3. Layer Flow

#### 3a. PromptBuilder.buildSystemPrompt (Orchestrator)
- File: `src/prompt-builder.ts:294-321`
- Load workflow prompt → append persona → **processVariables last** (line 317)
- Transformation: `(systemPrompt, userId)` → `processVariables(systemPrompt, userId)`

#### 3b. processVariables (Pattern Matcher)
- File: `src/prompt-builder.ts:160-174`
- Pattern: `VARIABLE_PATTERN = /\{\{([\w.]+)\}\}/g` (line 25)
- For each match:
  - `varName === 'llm_chat_config'` → `llmChatConfigStore.toPromptSnippet()`
  - `varName.startsWith('user.') && userId` → `resolveUserVariable(varName, userId)`
  - else → `match` (leave as-is)

#### 3c. resolveUserVariable (Value Resolver)
- File: `src/prompt-builder.ts:179-195`
- Transformation map:
  - `'user.email'` → `settings.email`
  - `'user.displayName'` → `settings.slackName`
  - `'user.slackId'` → `settings.userId`
  - `'user.jiraName'` → `settings.jiraName`
  - unknown → `undefined` → falls back to original `{{...}}` match

#### 3d. UserSettingsStore (Data Source)
- `getUserSettings(userId)` → returns full `UserSettings` object or `undefined`
- No API call — reads from in-memory cache

### 4. Side Effects
- None (pure read operation)

### 5. Error Paths
| Condition | Handling | Impact |
|-----------|----------|--------|
| `userId` is `undefined` | `user.*` branch skipped | Variables left as `{{user.email}}` |
| `getUserSettings()` returns `undefined` | `resolveUserVariable` returns `undefined` | Variable left as-is |
| `settings.email` is `undefined` | Returns `undefined` → `match` | Variable left as `{{user.email}}` |
| Unknown `user.xxx` variable | switch default → `undefined` | Variable left as `{{user.xxx}}` |

### 6. Output
- Resolved prompt string with variables substituted
- Example: `Co-Authored-By: {{user.displayName}} <{{user.email}}>` → `Co-Authored-By: Zhuge <z@insightquest.io>`

### 7. Observability
- No logging in processVariables/resolveUserVariable

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `should resolve user.email from UserSettings` | Happy Path | S2, Section 3c, email mapping |
| `should resolve user.displayName from slackName` | Happy Path | S2, Section 3c, displayName mapping |
| `should resolve user.slackId from userId` | Happy Path | S2, Section 3c, slackId mapping |
| `should resolve user.jiraName from jiraName` | Happy Path | S2, Section 3c, jiraName mapping |
| `should pass userId to processVariables in buildSystemPrompt` | Contract | S2, Section 3a→3b transformation |

---

## Scenario 3 — Fallback When Email Unavailable

### 1. Entry Point
- Same as S2: `PromptBuilder.buildSystemPrompt(userId, workflow)`
- Condition: User has no email cached (new user, scope missing, API failed)

### 2. Input
- `userId`: string (exists but has no email in UserSettings)
- Prompt content with `{{user.email}}`

### 3. Layer Flow

#### 3a. resolveUserVariable
- `getUserSettings(userId)` returns settings object WITH `email: undefined`
- `settings.email` → `undefined`
- Returns `undefined` → `processVariables` returns original `match` = `{{user.email}}`

#### 3b. Prompt Output
- `Co-Authored-By: {{user.displayName}} <{{user.email}}>` remains in prompt
- `common.prompt` instructs LLM: "변수가 치환되지 않고 `{{user.email}}` 형태로 남아있으면, 해당 정보가 미등록 상태다. 이 경우 Co-Authored-By 라인을 **생략**하라."

### 4. Side Effects
- None

### 5. Error Paths
| Condition | Handling | Impact |
|-----------|----------|--------|
| No userId provided | `user.*` check `&& userId` fails | All user vars unresolved |
| User not in store | `getUserSettings()` → `undefined` | All user vars unresolved |
| Email field missing | `settings.email` → `undefined` | Only email unresolved |

### 6. Output
- Unresolved variables remain as literal `{{user.email}}` in prompt
- LLM expected to handle via common.prompt fallback instruction

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `should leave user.email as-is when email not set` | Sad Path | S3, Section 3a |
| `should leave all user vars as-is when userId not provided` | Sad Path | S3, Section 5, row 1 |
| `should leave all user vars as-is when user not in store` | Sad Path | S3, Section 5, row 2 |

---

## Scenario 4 — Co-Authored-By in Workflow Commits

### 1. Entry Point
- Trigger: Workflow prompt loaded via `loadWorkflowPrompt(workflow)`
- Affected files:
  - `src/prompt/workflows/jira-create-pr.prompt` (3 commit templates)
  - `src/prompt/workflows/pr-fix-and-update.prompt` (1 commit template)

### 2. Input
- Workflow type: `'jira-create-pr'` or `'pr-fix-and-update'`

### 3. Template Locations

#### jira-create-pr.prompt
- **Red phase** (line ~67): `Co-Authored-By: {{user.displayName}} <{{user.email}}>`
- **Green phase** (line ~106): `Co-Authored-By: {{user.displayName}} <{{user.email}}>`
- **Refactor phase** (line ~133): `Co-Authored-By: {{user.displayName}} <{{user.email}}>`

#### pr-fix-and-update.prompt
- **Commit template** (line ~109): `Co-Authored-By: {{user.displayName}} <{{user.email}}>`

### 4. Side Effects
- None at prompt level — side effect is in LLM-generated git commits

### 5. Verification
- After S2 substitution, templates should read: `Co-Authored-By: Zhuge <z@insightquest.io>`
- If S3 (fallback), LLM should omit the line per common.prompt instruction

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `jira-create-pr prompt should contain Co-Authored-By template` | Contract | S4, Section 3, jira-create-pr |
| `pr-fix-and-update prompt should contain Co-Authored-By template` | Contract | S4, Section 3, pr-fix-and-update |
| `common.prompt should document fallback behavior` | Contract | S4, Section 5 |

---

## ⚠️ Implementation Gap: displayName Not Stored

**Finding**: `getUserProfile()` returns `displayName` but `StreamExecutor` only stores `email`:
```typescript
// stream-executor.ts:244-246
if (profile.email) {
  userSettingsStore.setUserEmail(user, profile.email);
}
// displayName is NOT stored → user.displayName relies on slackName from other paths
```

`user.displayName` resolves to `settings.slackName`, which is set via:
- `ensureUserExists(userId, slackName)` — onboarding
- `updateUserJiraInfo(userId, slackName)` — Jira mapping sync

If neither path ran, `slackName` is `undefined` and `{{user.displayName}}` stays unresolved.

**Recommendation**: Store displayName alongside email in StreamExecutor:
```typescript
if (profile.email) userSettingsStore.setUserEmail(user, profile.email);
if (profile.displayName) userSettingsStore.patchUserSettings(user, { slackName: profile.displayName });
```
Switching cost: **tiny (~3 lines)**. This is a bug, not a design decision.

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Test file location: extend existing `prompt-builder.test.ts` | tiny | Tests already exist there |
| Mock pattern: follow existing `vi.mock('./user-settings-store')` | tiny | Exact pattern in file |
| Separate test describe block for user variables | tiny | Clean organization |

## Implementation Status
| Scenario | Trace | Code | Tests (RED) | Status |
|----------|-------|------|-------------|--------|
| 1. Email Auto-Fetch | ✅ | ✅ implemented | ❌ missing | Tests needed |
| 2. Variable Substitution | ✅ | ✅ implemented | ❌ missing | Tests needed |
| 3. Fallback | ✅ | ✅ implemented | ❌ missing | Tests needed |
| 4. Workflow Templates | ✅ | ✅ implemented | ❌ missing | Tests needed |

## Next Step
→ Write RED contract tests, then verify with `stv:verify`
→ Fix displayName storage gap (tiny, ~3 lines)
