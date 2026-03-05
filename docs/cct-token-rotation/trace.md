# CCT Token Rotation — Vertical Trace

> STV Trace | Created: 2026-03-05
> Spec: docs/cct-token-rotation/spec.md

## 목차
1. [Scenario 1 — Token Initialization](#scenario-1--token-initialization)
2. [Scenario 2 — `cct` Status Command](#scenario-2--cct-status-command)
3. [Scenario 3 — `set_cct` Manual Switch](#scenario-3--set_cct-manual-switch)
4. [Scenario 4 — Auto-Rotation on Rate Limit](#scenario-4--auto-rotation-on-rate-limit)
5. [Scenario 5 — All Tokens on Cooldown](#scenario-5--all-tokens-on-cooldown)

---

## Scenario 1 — Token Initialization

### 1.1 ASCII Diagram

```
 App Startup (src/index.ts)
       │
       │  validateConfig() → runPreflightChecks()
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  tokenManager.initialize()                          │
 │  src/token-manager.ts                               │
 │                                                     │
 │  Step 1: Read CLAUDE_CODE_OAUTH_TOKEN_LIST env      │
 │    const list = process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST │
 │                                                     │
 │  Step 2: Fallback to single token                   │
 │    if (!list) → read CLAUDE_CODE_OAUTH_TOKEN        │
 │    if neither → tokens = [] (no-op, SDK handles)    │
 │                                                     │
 │  Step 3: Parse comma-separated list                 │
 │    "tokenA,tokenB,tokenC".split(",")                │
 │    → [{name:"cct1", value:"tokenA"},                │
 │       {name:"cct2", value:"tokenB"},                │
 │       {name:"cct3", value:"tokenC"}]                │
 │                                                     │
 │  Step 4: Set activeIndex = 0                        │
 │    applyToken() → process.env.CLAUDE_CODE_OAUTH_TOKEN = tokens[0].value │
 │                                                     │
 │  Step 5: Load ADMIN_USERS env                       │
 │    config.adminUsers = "U09F1M5MML1".split(",")     │
 │                                                     │
 │  Error paths:                                       │
 │    Empty list after split → use single token fallback │
 │    No tokens at all → log warning, continue (SDK    │
 │    may use ~/.claude credentials)                   │
 └─────────────────────────────────────────────────────┘
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  Log: "TokenManager initialized: N tokens loaded,   │
 │        active=cct1"                                 │
 │  (token values always masked in logs)               │
 └─────────────────────────────────────────────────────┘
```

### 1.2 State
```typescript
interface TokenEntry {
  name: string;            // "cct1", "cct2", ...
  value: string;           // actual token value
  cooldownUntil: Date | null;  // null = available
}
// In-memory only, no file persistence needed
```

### 1.3 Error Paths

| Condition | Behavior |
|-----------|----------|
| `CLAUDE_CODE_OAUTH_TOKEN_LIST` not set | Fallback to single `CLAUDE_CODE_OAUTH_TOKEN` |
| Neither env var set | Empty token pool, log warning |
| Empty string in comma split | Filter out empty entries |

### 1.4 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `initialize_withTokenList_loadsMultipleTokens` | Happy Path | Step 3 |
| `initialize_withSingleToken_fallsBackToSingle` | Happy Path | Step 2 |
| `initialize_withNoTokens_logsWarning` | Sad Path | Error path 3 |
| `initialize_appliesFirstTokenToProcessEnv` | Side-Effect | Step 4 |
| `initialize_filtersEmptyEntries` | Contract | Step 3 edge |

---

## Scenario 2 — `cct` Status Command

### 2.1 ASCII Diagram

```
 Slack User (admin)
       │
       │  "cct" message
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  CommandParser.isCctCommand("cct")                  │
 │  src/slack/command-parser.ts                        │
 │                                                     │
 │  Pattern: /^\/?(?:cct|set_cct)(?:\s+\S+)?$/i       │
 │  Returns: true                                      │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  CctHandler.execute(ctx)                            │
 │  src/slack/commands/cct-handler.ts                  │
 │                                                     │
 │  Step 1: Admin check                                │
 │    isAdminUser(ctx.user) → check config.adminUsers  │
 │    if (!admin) → say("⛔ Admin only") → return      │
 │                                                     │
 │  Step 2: Parse action                               │
 │    CommandParser.parseCctCommand("cct")              │
 │    → { action: "status" }                           │
 │                                                     │
 │  Step 3: Get all tokens                             │
 │    tokenManager.getAllTokens()                       │
 │    → readonly TokenEntry[]                          │
 │                                                     │
 │  Step 4: Get active token                           │
 │    tokenManager.getActiveToken()                    │
 │    → TokenEntry { name: "cct1", ... }               │
 │                                                     │
 │  Step 5: Format output                              │
 │    For each token:                                  │
 │      mask value: "sk-a...xyz"                       │
 │      if active: "(active)"                          │
 │      if cooldown: "(rate limited until 7:00 PM)"    │
 │      if available: "" (no suffix)                   │
 │                                                     │
 │  Error paths:                                       │
 │    Not admin → "⛔ Admin only command"               │
 │    No tokens configured → "No tokens configured"    │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  Response: Slack message                            │
 │  "🔑 *CCT Token Status*                            │
 │   cct1=sk-a...xyz *(active)*                       │
 │   cct2=sk-b...abc                                  │
 │   cct3=sk-c...def _(rate limited until 7:00 PM)_"  │
 └─────────────────────────────────────────────────────┘
```

### 2.2 Error Paths

| Condition | Error | Response |
|-----------|-------|----------|
| Non-admin user | Permission denied | "⛔ Admin only command" |
| No tokens configured | Empty pool | "No CCT tokens configured" |

### 2.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `cctStatus_adminUser_showsAllTokens` | Happy Path | Steps 3-5 |
| `cctStatus_nonAdmin_rejectsWithError` | Sad Path | Step 1 error |
| `cctStatus_showsActiveIndicator` | Contract | Step 5 active |
| `cctStatus_showsCooldownTime` | Contract | Step 5 cooldown |
| `cctStatus_masksTokenValues` | Contract | Step 5 mask |
| `cctStatus_noTokens_showsMessage` | Sad Path | Error path 2 |

---

## Scenario 3 — `set_cct` Manual Switch

### 3.1 ASCII Diagram

```
 Slack User (admin)
       │
       │  "set_cct cct2" message
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  CommandParser.parseCctCommand("set_cct cct2")      │
 │  src/slack/command-parser.ts                        │
 │                                                     │
 │  → { action: "set", target: "cct2" }                │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  CctHandler.execute(ctx)                            │
 │  src/slack/commands/cct-handler.ts                  │
 │                                                     │
 │  Step 1: Admin check (same as Scenario 2)           │
 │                                                     │
 │  Step 2: Call tokenManager.setActiveToken("cct2")   │
 │    - Find token by name                             │
 │    - Set activeIndex to matching index              │
 │    - Call applyToken()                              │
 │      → process.env.CLAUDE_CODE_OAUTH_TOKEN = token.value │
 │    - Clear cooldown on target if any                │
 │    - Return true                                    │
 │                                                     │
 │  Step 3: Respond with confirmation                  │
 │    "✅ Active token switched to cct2 (sk-b...abc)"  │
 │                                                     │
 │  Error paths:                                       │
 │    Not admin → "⛔ Admin only command"               │
 │    Unknown token name → "❌ Unknown token: cctX"     │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  Side-Effect:                                       │
 │    process.env.CLAUDE_CODE_OAUTH_TOKEN = new value  │
 │    All subsequent SDK query() calls use new token   │
 └─────────────────────────────────────────────────────┘
```

### 3.2 Error Paths

| Condition | Error | Response |
|-----------|-------|----------|
| Non-admin user | Permission denied | "⛔ Admin only command" |
| Unknown token name | Not found | "❌ Unknown token: cctX" |

### 3.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `setCct_validToken_switchesActive` | Happy Path | Step 2 |
| `setCct_updatesProcessEnv` | Side-Effect | Step 2 applyToken |
| `setCct_clearsCooldownOnTarget` | Side-Effect | Step 2 clear cooldown |
| `setCct_nonAdmin_rejects` | Sad Path | Step 1 error |
| `setCct_unknownToken_rejects` | Sad Path | Error path 2 |
| `setCct_showsConfirmation` | Contract | Step 3 |

---

## Scenario 4 — Auto-Rotation on Rate Limit

### 4.1 ASCII Diagram

```
 Claude SDK query() → Error
       │
       │  "You've hit your limit · resets 7pm (Asia/Seoul)"
       │  OR process exit code 1
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  StreamExecutor.handleError(error, ...)             │
 │  src/slack/pipeline/stream-executor.ts:539          │
 │                                                     │
 │  Step 1: Detect rate limit                          │
 │    isRecoverableClaudeSdkError(error) → true        │
 │    isRateLimitError(error) → true (NEW check)       │
 │      Pattern: "you've hit your limit"               │
 │                                                     │
 │  Step 2: Parse cooldown time from error message     │
 │    parseCooldownTime(error.message)                 │
 │      regex: /resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)/i │
 │      "resets 7pm" → today 19:00 KST                │
 │      "resets 7:30pm" → today 19:30 KST             │
 │      null if no match → default 1 hour cooldown     │
 │                                                     │
 │  Step 3: Capture current token value BEFORE rotate  │
 │    const failedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN │
 │                                                     │
 │  Step 4: Call TokenManager.rotateOnRateLimit()      │
 │    tokenManager.rotateOnRateLimit(                  │
 │      failedToken, cooldownUntil)                    │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  TokenManager.rotateOnRateLimit(                    │
 │    failedTokenValue, cooldownUntil)                 │
 │  src/token-manager.ts                               │
 │                                                     │
 │  Step 5: CAS check (idempotent)                     │
 │    if (tokens[activeIndex].value !== failedTokenValue) │
 │      → return { rotated: false, reason: "already_rotated" } │
 │      (Another session already rotated this token)   │
 │                                                     │
 │  Step 6: Set cooldown on failed token               │
 │    tokens[activeIndex].cooldownUntil = cooldownUntil │
 │                                                     │
 │  Step 7: Find next available token                  │
 │    for i in 1..tokens.length:                       │
 │      nextIdx = (activeIndex + i) % tokens.length    │
 │      if tokens[nextIdx].cooldownUntil == null       │
 │         OR tokens[nextIdx].cooldownUntil < now:     │
 │        → activeIndex = nextIdx                      │
 │        → applyToken()                               │
 │        → return { rotated: true, newToken: name }   │
 │                                                     │
 │  Step 8: All on cooldown (fallback)                 │
 │    → Pick token with earliest cooldownUntil         │
 │    → return { rotated: true, newToken: name,        │
 │               allOnCooldown: true }                 │
 │                                                     │
 │  Invariants:                                        │
 │    - Only rotates if caller's token matches current │
 │    - process.env always reflects activeIndex        │
 │    - cooldownUntil is always set on failed token    │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  Back in StreamExecutor.handleError():              │
 │                                                     │
 │  Step 9: Log rotation result                        │
 │    if rotated: logger.info("Token rotated: cct1→cct2") │
 │    if already_rotated: logger.debug("Already rotated") │
 │                                                     │
 │  Step 10: Append rotation info to error message     │
 │    "❌ [Bot Error] You've hit your limit..."         │
 │    "🔄 Token auto-rotated: cct1 → cct2"            │
 │    OR "⚠️ All tokens on cooldown, using cct2        │
 │        (resets at 7:00 PM)"                         │
 └─────────────────────────────────────────────────────┘
```

### 4.2 Error Paths

| Condition | Error | Response |
|-----------|-------|----------|
| Cannot parse cooldown time | Default 1hr | Uses Date.now() + 3600000 |
| Only 1 token in pool | Same token re-selected | Warning: "Only one token available" |
| TokenManager not initialized | No tokens | Skip rotation, normal error flow |

### 4.3 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `rotateOnRateLimit_switchesToNextToken` | Happy Path | Steps 5-7 |
| `rotateOnRateLimit_idempotent_alreadyRotated` | Contract | Step 5 CAS |
| `rotateOnRateLimit_setsCooldownOnFailed` | Side-Effect | Step 6 |
| `rotateOnRateLimit_updatesProcessEnv` | Side-Effect | Step 7 applyToken |
| `rotateOnRateLimit_skipsTokensOnCooldown` | Contract | Step 7 loop |
| `parseCooldownTime_parsesHourOnly` | Contract | Step 2 "7pm" |
| `parseCooldownTime_parsesHourMinute` | Contract | Step 2 "7:30pm" |
| `parseCooldownTime_returnsNullOnNoMatch` | Sad Path | Step 2 null |
| `handleError_rateLimitDetected_triggersRotation` | Integration | Steps 1-4 |
| `handleError_appendsRotationInfoToMessage` | Contract | Step 10 |

---

## Scenario 5 — All Tokens on Cooldown

### 5.1 ASCII Diagram

```
 Rate limit on last available token
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  TokenManager.rotateOnRateLimit(failedToken, cooldown) │
 │  src/token-manager.ts                               │
 │                                                     │
 │  Step 1: CAS check passes (token matches)           │
 │  Step 2: Set cooldown on current                    │
 │  Step 3: Scan all tokens — ALL have cooldownUntil > now │
 │                                                     │
 │  Step 4: Find earliest recovery                     │
 │    tokens.reduce((earliest, t) =>                   │
 │      t.cooldownUntil < earliest.cooldownUntil       │
 │        ? t : earliest)                              │
 │                                                     │
 │  Step 5: Switch to earliest-recovery token          │
 │    activeIndex = earliestIndex                      │
 │    applyToken()                                     │
 │                                                     │
 │  Return: { rotated: true, newToken: "cct2",         │
 │            allOnCooldown: true,                     │
 │            earliestRecovery: Date }                 │
 └──────────────────────┬──────────────────────────────┘
                        │
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │  StreamExecutor: Enhanced error message              │
 │                                                     │
 │  "❌ [Bot Error] Rate limit reached                  │
 │   ⚠️ All tokens on cooldown!                        │
 │   Using cct2 (earliest recovery: 7:00 PM)           │
 │   Next request may fail until then."                │
 └─────────────────────────────────────────────────────┘
```

### 5.2 Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `allCooldown_selectsEarliestRecovery` | Happy Path | Steps 3-5 |
| `allCooldown_returnsAllOnCooldownFlag` | Contract | Return value |
| `allCooldown_singleToken_reusesIt` | Edge Case | 1 token pool |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| `isRateLimitError()` 별도 메서드 | tiny | 기존 isRecoverable에 추가하지 않고 분리하여 rotation 전용 |
| Cooldown 파싱 정규식 | tiny | "resets Xpm" 형태만 파싱, 실패 시 1시간 기본값 |
| process.env snapshot before rotate | tiny | CAS 비교를 위한 필수 단계 |
| 에러 메시지에 rotation 정보 추가 | tiny | 유저에게 전환 사실 고지 |
| Token은 in-memory only | small | 재시작 시 env에서 다시 로드, 파일 영속화 불필요 |

## Implementation Status

| Scenario | Trace | Tests | Verify | Status |
|----------|-------|-------|--------|--------|
| 1. Token Initialization | done | GREEN | Verified | Complete |
| 2. `cct` Status Command | done | GREEN | Verified | Complete |
| 3. `set_cct` Manual Switch | done | GREEN | Verified | Complete |
| 4. Auto-Rotation on Rate Limit | done | GREEN | Verified | Complete |
| 5. All Tokens on Cooldown | done | GREEN | Verified | Complete |

## Trace Deviations

None — 구현이 trace와 정확히 일치.

## Verified At

2026-03-05 — All 5 scenarios GREEN + Verified
- Tests: 31/31 passed (token-manager + cct-handler)
- Full suite: 869 passed, 0 failed
- Type check: clean
