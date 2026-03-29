# MCP Tool Permission System — Spec

> STV Spec | Created: 2026-03-29

## 1. Overview

MCP 도구에 대한 세분화된 접근 제어 시스템. config.json에서 각 MCP 서버의 도구별로 필요한 권한 레벨(read/write)을 정의하고, 일반 유저는 시간 기반으로 권한을 요청하여 Admin 승인 후 사용할 수 있다.

현재 soma-work의 도구 접근 제어는 이진(bypass ON/OFF)이다. 이 기능은 도구 단위로 read/write 레벨을 분리하여 최소 권한 원칙을 실현한다.

## 2. User Stories

- As an **admin**, I want all MCP tools to be always accessible, so that I can operate without friction.
- As a **regular user**, I want to request read/write access to specific MCP tools with a time duration, so that I get temporary access when needed.
- As an **admin**, I want to approve/deny tool access requests via Slack, so that I control who accesses sensitive tools.
- As a **regular user**, I want to check my current permission status, so that I know what tools I can use.
- As an **operator**, I want to define per-tool permission levels in config.json, so that tool access is declaratively configured.

## 3. Acceptance Criteria

- [ ] config.json supports `permission` field per MCP server section (e.g., `server-tools.permission`)
- [ ] Each tool maps to a required permission level: `"read"` or `"write"`
- [ ] Admin users (ADMIN_USERS env) bypass all permission checks
- [ ] Non-admin users are blocked from permission-gated tools by default
- [ ] Users can request `read` or `write` access via MCP tool with duration (e.g., "24h", "7d")
- [ ] Admin receives Slack approval message with Approve/Deny buttons
- [ ] Approved grants are stored with expiration timestamp
- [ ] Expired grants are automatically rejected on next check
- [ ] `db_query` requires `write` permission, `logs` requires `read` permission (via config)
- [ ] New MCP tools: `request_permission`, `check_permission`, `revoke_permission`
- [ ] McpConfigBuilder filters `allowedTools` based on user's active grants

## 4. Scope

### In-Scope
- config.json permission schema per MCP server tool
- File-based grant store (mcp-tool-grants.json in DATA_DIR)
- MCP server for permission request/check/revoke
- Slack approval UI for admin (reuse existing action handler pattern)
- McpConfigBuilder integration to filter tools
- PreToolUse hook as final guard

### Out-of-Scope
- Database-backed grant store (file is sufficient for current scale)
- Granular per-resource permissions (e.g., per-database within db_query)
- Permission audit log (future enhancement)
- Self-service admin panel (Slack-only flow)

## 5. Architecture

### 5.1 Layer Structure

```
config.json (declarative tool→level mapping)
    ↓
McpConfigBuilder.buildConfig()
    ├─ isAdminUser() → bypass all
    ├─ McpToolGrantStore.getActiveGrants(userId) → filter allowedTools
    └─ PreToolUse hook → final enforcement
    ↓
mcp-tool-permission MCP server (request/check/revoke)
    ├─ SharedStore → Slack approval IPC
    └─ McpToolGrantStore → persist grants
```

### 5.2 Config Schema

```json
{
  "server-tools": {
    "permission": {
      "db_query": "write",
      "logs": "read",
      "list": "read",
      "list_service": "read"
    },
    "dev2": { "ssh": { "host": "..." }, ... }
  }
}
```

`permission` is a reserved key within MCP server config sections. If present, its values define the minimum permission level required for each tool.

### 5.3 Grant Store Schema (mcp-tool-grants.json)

```json
{
  "U_USER_ID": {
    "server-tools": {
      "read": {
        "grantedAt": "2026-03-29T05:00:00Z",
        "expiresAt": "2026-03-30T05:00:00Z",
        "grantedBy": "U_ADMIN_ID"
      },
      "write": null
    }
  }
}
```

Grant hierarchy: `write` implies `read`. If a user has `write`, they can use both `read` and `write` tools.

### 5.4 MCP Tools (mcp-tool-permission server)

| Tool | Description | Inputs |
|------|-------------|--------|
| `request_permission` | Request access to an MCP server | `server` (string), `level` ("read"\|"write"), `duration` (string, e.g. "24h", "7d") |
| `check_permission` | Check current grants for a user | `server?` (optional, shows all if omitted) |
| `revoke_permission` | Admin revokes a user's grant | `user` (string), `server` (string), `level?` ("read"\|"write"\|"all") |

### 5.5 Integration Points

1. **McpConfigBuilder.buildAllowedTools()** — Filter `mcp__server-tools__*` based on user grants
2. **PreToolUse hook** — Final enforcement: deny if tool requires permission user doesn't have
3. **Slack action handler** — Handle Approve/Deny button clicks for grant requests
4. **config.json loader** — Parse `permission` key from MCP server sections

### 5.6 Permission Check Flow

```
Tool call arrives
    ↓
PreToolUse hook fires
    ↓
Is user admin? → YES → allow
    ↓ NO
Does tool's MCP server have `permission` config? → NO → allow
    ↓ YES
What level does this tool require? (e.g., db_query → "write")
    ↓
Does user have active grant at that level? → YES → allow
    ↓ NO
→ DENY with message: "Permission required. Use mcp__mcp-tool-permission__request_permission to request access."
```

### 5.7 Approval Flow

```
User calls request_permission(server="server-tools", level="write", duration="24h")
    ↓
MCP server validates request
    ↓
Sends Slack DM to all ADMIN_USERS with Approve/Deny buttons
    ↓
Admin clicks Approve
    ↓
Action handler stores grant in McpToolGrantStore
    ↓
MCP server returns success to Claude
    ↓
User can now use write-level tools until expiry
```

## 6. Non-Functional Requirements

- **Performance**: Grant check is O(1) in-memory lookup (loaded from file on startup, cached)
- **Security**: PreToolUse hook as defense-in-depth (even if allowedTools filter fails)
- **Reliability**: Atomic file writes for grant store (tmp + rename pattern from UnifiedConfig)
- **Scalability**: File-based store is fine for <100 users. No DB needed.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| File-based grant store (not DB) | tiny | Matches SharedStore/UserSettingsStore patterns |
| `write` implies `read` | tiny | Standard RBAC hierarchy, reduces config complexity |
| `permission` as reserved config key | tiny | Avoids breaking existing server-tools config structure |
| Reuse SharedStore for approval IPC | small | Same cross-process communication pattern as permission-prompt |
| PreToolUse hook as final guard | small | Follows existing dangerous-command interceptor pattern |
| Duration parsed as string (24h/7d/30d) | tiny | Simple, human-readable format |
| Grant expiry check at tool-call time | tiny | No background timer needed |
| Slack DM to admins for approval | small | Consistent with existing permission prompt UI |

## 8. Open Questions

None. Requirements are fully specified.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace`
