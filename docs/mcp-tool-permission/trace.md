# MCP Tool Permission System — Vertical Trace

> STV Trace | Created: 2026-03-29
> Spec: docs/mcp-tool-permission/spec.md

## Table of Contents
1. [S1 — Config permission parsing](#scenario-1)
2. [S2 — Admin bypasses permission check](#scenario-2)
3. [S3 — Non-admin blocked without grant](#scenario-3)
4. [S4 — Permission request + admin approval](#scenario-4)
5. [S5 — Active grant allows tool access (write implies read)](#scenario-5)
6. [S6 — Expired grant blocks access](#scenario-6)
7. [S7 — Check permission status](#scenario-7)
8. [S8 — Admin revokes grant](#scenario-8)

---

## Scenario 1 — Config permission parsing

### 1. API Entry
- Internal: config.json loaded at startup
- No HTTP endpoint — consumed by McpConfigBuilder

### 2. Input
```json
{
  "server-tools": {
    "permission": {
      "db_query": "write",
      "logs": "read",
      "list": "read",
      "list_service": "read"
    },
    "dev2": { "ssh": { "host": "..." } }
  }
}
```
- Validation: `permission` value must be `"read"` or `"write"` per tool key
- `permission` is a reserved key — not treated as a server config entry

### 3. Layer Flow

#### 3a. Config Loader
- `loadMcpToolPermissions(configFile)` reads config.json
- Extracts `permission` key from each MCP server section
- Returns `Record<string, Record<string, PermissionLevel>>` (serverName → toolName → level)
- Transformation: `config["server-tools"]["permission"]["db_query"]` → `McpToolPermissionConfig["server-tools"]["db_query"]` = `"write"`

#### 3b. McpConfigBuilder
- Calls `loadMcpToolPermissions()` during `buildConfig()`
- Stores result as `this.toolPermissions`
- Used in `buildAllowedTools()` and PreToolUse hook

### 4. Side Effects
- None (read-only config parsing)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| `permission` key missing | No error | All tools allowed (backward compatible) |
| Invalid level value (not read/write) | Warning log | Tool treated as unrestricted |
| Config file missing | No error | No permission gating |

### 6. Output
- `McpToolPermissionConfig`: `{ "server-tools": { "db_query": "write", "logs": "read" } }`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `parsesPermissionFromConfig` | Happy Path | S1, Section 3a |
| `ignoresPermissionKeyAsServerConfig` | Contract | S1, Section 3a reserved key |
| `backwardCompatibleWhenNoPermission` | Sad Path | S1, Section 5 |
| `warnsOnInvalidPermissionLevel` | Sad Path | S1, Section 5 |

---

## Scenario 2 — Admin bypasses permission check

### 1. API Entry
- Internal: PreToolUse hook in ClaudeHandler
- Trigger: Any tool call from admin user

### 2. Input
- `userId`: admin Slack ID (in ADMIN_USERS env)
- `toolName`: e.g., `mcp__server-tools__db_query`

### 3. Layer Flow

#### 3a. PreToolUse Hook
- `isAdminUser(slackContext.user)` → `true`
- Returns `{ continue: true }` immediately
- No grant store lookup

### 4. Side Effects
- None

### 5. Error Paths
- None (admin always passes)

### 6. Output
- Tool execution proceeds

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `adminBypassesPermissionCheck` | Happy Path | S2, Section 3a |
| `adminAccessesWriteToolWithoutGrant` | Contract | S2, Section 3a |

---

## Scenario 3 — Non-admin blocked without grant

### 1. API Entry
- Internal: McpConfigBuilder.buildAllowedTools() + PreToolUse hook
- Trigger: Non-admin user's tool call on permission-gated tool

### 2. Input
- `userId`: non-admin Slack ID
- `toolName`: `mcp__server-tools__db_query` (requires "write")
- No active grant for user

### 3. Layer Flow

#### 3a. McpConfigBuilder.buildAllowedTools()
- Checks `toolPermissions["server-tools"]` → `{ "db_query": "write" }`
- Checks `grantStore.getActiveGrant(userId, "server-tools")` → `null`
- `mcp__server-tools__db_query` excluded from allowedTools
- `mcp__server-tools__logs` also excluded (no grant at all)

#### 3b. PreToolUse Hook (defense-in-depth)
- If tool somehow bypasses allowedTools filter:
- `getRequiredLevel("server-tools", "db_query")` → `"write"`
- `grantStore.getActiveGrant(userId, "server-tools")` → `null`
- Returns `{ permissionDecision: 'deny' }` with message

### 4. Side Effects
- None

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| No grant exists | Tool blocked | Message: "Permission required. Request via mcp__mcp-tool-permission__request_permission" |

### 6. Output
- Tool call denied with guidance message

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `nonAdminBlockedWithoutGrant` | Happy Path | S3, Section 3a |
| `permissionGatedToolsExcludedFromAllowedTools` | Contract | S3, Section 3a |
| `preToolUseHookDeniesUngrantedTool` | Contract | S3, Section 3b |

---

## Scenario 4 — Permission request + admin approval

### 1. API Entry
- MCP Tool: `mcp__mcp-tool-permission__request_permission`

### 2. Input
```json
{
  "server": "server-tools",
  "level": "write",
  "duration": "24h"
}
```
- Validation: `server` must exist in config, `level` must be "read"|"write", `duration` must match pattern `\d+[hdw]`

### 3. Layer Flow

#### 3a. MCP Tool Handler (mcp-tool-permission server)
- Receives request from Claude
- Parses duration: `"24h"` → 24 * 3600 * 1000 ms
- Extracts user from `SLACK_CONTEXT` env
- Builds Slack approval message for all admin users
- Transformation: `Request.duration("24h")` → `parseDuration("24h")` → `86400000` ms → `expiresAt = now + 86400000`

#### 3b. Slack Approval IPC
- Stores pending grant request in SharedStore
- Sends Slack message to admin users via DM with Approve/Deny buttons
- Payload includes: `{ requestId, userId, server, level, duration, expiresAt }`
- Waits for admin response (5 min timeout)

#### 3c. Admin clicks Approve
- Slack action handler validates admin identity via `isAdminUser()`
- Calls `grantStore.setGrant(userId, server, level, expiresAt, adminUserId)`
- Stores response in SharedStore

#### 3d. Grant Store
- Transaction: atomic file write (tmp + rename)
- Persisted grant:
  - `grants[userId][server][level]` = `{ grantedAt, expiresAt, grantedBy }`
  - If granting `write`, also grants `read` implicitly (no separate entry needed)

### 4. Side Effects
- File: `{DATA_DIR}/mcp-tool-grants.json` INSERT/UPDATE grant record
- Slack: DM to admins with approval request
- Slack: Approval message updated to show result

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Server not in config | Error response | "Unknown MCP server: X" |
| Invalid duration format | Error response | "Invalid duration. Use format: 24h, 7d, 4w" |
| Admin denies | Grant not stored | "Permission request denied by admin" |
| Approval timeout (5min) | No grant | "Permission request timed out" |
| User is admin | Shortcut | "Admin users have all permissions. No request needed." |

### 6. Output (success)
```json
{
  "status": "approved",
  "server": "server-tools",
  "level": "write",
  "expiresAt": "2026-03-30T05:00:00.000Z",
  "grantedBy": "U_ADMIN_ID"
}
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `requestPermissionHappyPath` | Happy Path | S4, Section 3a-3d |
| `parseDurationCorrectly` | Contract | S4, Section 3a transformation |
| `rejectsInvalidDuration` | Sad Path | S4, Section 5 |
| `rejectsUnknownServer` | Sad Path | S4, Section 5 |
| `adminDenialStoresNoGrant` | Sad Path | S4, Section 5 |
| `grantStoreAtomicWrite` | Side-Effect | S4, Section 4 |
| `writeGrantImpliesRead` | Contract | S4, Section 3d |

---

## Scenario 5 — Active grant allows tool access

### 1. API Entry
- Internal: McpConfigBuilder.buildAllowedTools() + PreToolUse hook

### 2. Input
- `userId`: non-admin with active write grant for server-tools
- `toolName`: `mcp__server-tools__db_query` (requires "write")

### 3. Layer Flow

#### 3a. McpConfigBuilder.buildAllowedTools()
- `grantStore.getActiveGrant(userId, "server-tools")` → `{ read: {...}, write: { expiresAt: future } }`
- User has "write" → includes all server-tools tools in allowedTools
- Transformation: `grant.write.expiresAt > Date.now()` → `hasLevel("write")` → `true`

#### 3b. PreToolUse Hook
- `getRequiredLevel("server-tools", "db_query")` → `"write"`
- `hasActiveGrant(userId, "server-tools", "write")` → `true`
- Returns `{ continue: true }`

### 4. Side Effects
- None

### 5. Error Paths
- None (active valid grant)

### 6. Output
- Tool execution proceeds

### 7. Observability
- Log: `McpToolPermission: User {userId} authorized for server-tools/db_query (write grant, expires {expiresAt})`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `activeWriteGrantAllowsWriteTool` | Happy Path | S5, Section 3 |
| `activeWriteGrantAllowsReadTool` | Contract | S5, Section 3a write implies read |
| `activeReadGrantAllowsReadTool` | Happy Path | S5, Section 3 |
| `activeReadGrantBlocksWriteTool` | Sad Path | S5, read insufficient for write |

---

## Scenario 6 — Expired grant blocks access

### 1. API Entry
- Internal: Grant store check

### 2. Input
- `userId`: user with expired grant
- Grant: `{ expiresAt: past_timestamp }`

### 3. Layer Flow

#### 3a. Grant Store
- `getActiveGrant(userId, "server-tools")` checks `expiresAt`
- `grant.write.expiresAt < Date.now()` → treat as no grant
- Returns `null` for expired level

### 4. Side Effects
- None (lazy cleanup; expired entries remain in file until next write)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Grant expired | Tool blocked | Same as S3 (no grant) |

### 6. Output
- Tool call denied

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `expiredGrantBlocksAccess` | Happy Path | S6, Section 3a |
| `expiredWriteGrantStillAllowsReadIfReadNotExpired` | Contract | S6, edge case |

---

## Scenario 7 — Check permission status

### 1. API Entry
- MCP Tool: `mcp__mcp-tool-permission__check_permission`

### 2. Input
```json
{
  "server": "server-tools"  // optional, omit to show all
}
```

### 3. Layer Flow

#### 3a. MCP Tool Handler
- Extracts user from `SLACK_CONTEXT`
- `grantStore.getGrants(userId)` → all grants
- If `server` specified, filter to that server
- For each grant, marks as "active" or "expired"

### 4. Side Effects
- None (read-only)

### 6. Output
```json
{
  "userId": "U_USER",
  "grants": {
    "server-tools": {
      "read": { "status": "active", "expiresAt": "2026-03-30T05:00:00Z", "grantedBy": "U_ADMIN" },
      "write": { "status": "expired", "expiresAt": "2026-03-28T05:00:00Z", "grantedBy": "U_ADMIN" }
    }
  },
  "toolPermissions": {
    "server-tools": { "db_query": "write", "logs": "read" }
  }
}
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `checkPermissionShowsActiveGrants` | Happy Path | S7 |
| `checkPermissionShowsExpiredStatus` | Contract | S7, Section 3a |
| `checkPermissionFiltersToServer` | Happy Path | S7, Section 2 |

---

## Scenario 8 — Admin revokes grant

### 1. API Entry
- MCP Tool: `mcp__mcp-tool-permission__revoke_permission`

### 2. Input
```json
{
  "user": "U_TARGET_USER",
  "server": "server-tools",
  "level": "all"  // "read" | "write" | "all"
}
```

### 3. Layer Flow

#### 3a. MCP Tool Handler
- Validates caller is admin via `isAdminUser()`
- `grantStore.revokeGrant(targetUser, server, level)`
- If level="all", removes both read and write
- If level="write", removes write only (read remains)
- If level="read", removes read only

#### 3b. Grant Store
- Atomic file write to persist removal

### 4. Side Effects
- File: `mcp-tool-grants.json` UPDATE (remove grant entries)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Caller not admin | Error | "Only admin users can revoke permissions" |
| No grant exists | Warning | "No active grant found" (still succeeds) |

### 6. Output
```json
{
  "status": "revoked",
  "user": "U_TARGET_USER",
  "server": "server-tools",
  "level": "all"
}
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `adminRevokesGrant` | Happy Path | S8 |
| `nonAdminCannotRevoke` | Sad Path | S8, Section 5 |
| `revokeAllClearsBothLevels` | Contract | S8, Section 3a |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Lazy expiry (check at access time, no background cleanup) | tiny | Simpler, no timer needed |
| Grant file in DATA_DIR alongside user-settings.json | tiny | Consistent with existing data patterns |
| PreToolUse hook as defense-in-depth on top of allowedTools | small | Same pattern as dangerous command filter |
| Duration format: `\d+[hdw]` (hours/days/weeks) | tiny | Simple, covers all practical durations |
| Approval DM to all admins (first responder wins) | small | Simple, works for small admin teams |
| mcp-tool-permission as separate MCP server process | small | Follows existing MCP server pattern |

## Implementation Status

| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Config permission parsing | done | RED | Ready |
| 2. Admin bypasses permission check | done | RED | Ready |
| 3. Non-admin blocked without grant | done | RED | Ready |
| 4. Permission request + admin approval | done | RED | Ready |
| 5. Active grant allows tool access | done | RED | Ready |
| 6. Expired grant blocks access | done | RED | Ready |
| 7. Check permission status | done | RED | Ready |
| 8. Admin revokes grant | done | RED | Ready |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work`
