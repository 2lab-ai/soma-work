# MCP Server Extraction + server-tools-mcp — Spec

> STV Spec | Created: 2026-03-27

## 1. Overview

soma-work의 MCP 서버 4개가 `src/` 루트에 산재. 각 서버는 독립 프로세스(`npx tsx <path>`)로 실행되므로, 디렉토리 구조가 이 사실을 반영해야 한다.

루트 레벨 `mcp-servers/` 디렉토리로 추출하고, 원격 서버 관리용 `server-tools-mcp`를 신규 생성한다.

## 2. User Stories

- As a developer, I want MCP servers in independent root-level directories, so that each server's boundaries are clear and future package extraction is possible.
- As a developer, I want shared MCP utilities in `mcp-servers/_shared/`, so that server-specific code is separated from domain code.
- As an AI operator, I want to list/monitor Docker containers on remote servers via MCP tool.
- As an AI operator, I want to view Docker logs via MCP tool for debugging.
- As an AI operator, I want to run SELECT queries on remote databases via MCP tool without exposing credentials.

## 3. Acceptance Criteria

- [ ] 4 MCP servers physically moved to `mcp-servers/{name}/`
- [ ] Shared utilities extracted to `mcp-servers/_shared/`
- [ ] Domain code imports use relative paths back to `src/` (no duplication)
- [ ] `mcp-config-builder.ts` resolves paths from new `mcp-servers/` location
- [ ] All existing tests pass after extraction
- [ ] `server-tools-mcp-server.ts` created with 4 tools
- [ ] SQL injection prevented — SELECT-only validation
- [ ] Docker commands execute via SSH
- [ ] server-tools conditionally registered in mcp-config-builder
- [ ] Contract tests for server-tools (config, SQL validation, tool handlers)

## 4. Scope

### In-Scope
- Extract 4 MCP servers to `mcp-servers/` root
- Extract `stderr-logger.ts` to `mcp-servers/_shared/`
- Extract `mcp-client.ts` to `mcp-servers/_shared/` (used by llm only, but general-purpose)
- Update imports in all moved files
- Update `mcp-config-builder.ts` path resolution
- Move test files alongside servers
- Create `server-tools-mcp-server.ts`
- Config schema for server-tools in `config.example.json`

### Out-of-Scope
- Docker Compose operations (up/down/restart)
- DB write operations
- Real-time log streaming (follow mode)
- PostgreSQL/other DB support
- Independent package.json per server (future work)
- tsconfig path aliases (relative imports suffice)

## 5. Architecture

### 5.1 Target Directory Structure

```
mcp-servers/
├── _shared/
│   ├── stderr-logger.ts         # Extracted from src/
│   ├── mcp-client.ts            # Extracted from src/ (depends on ../../src/logger.js)
│   └── index.ts                 # Re-exports
├── llm/
│   ├── llm-mcp-server.ts
│   └── llm-mcp-server.test.ts   # (if exists)
├── slack-thread/
│   ├── slack-thread-mcp-server.ts
│   ├── slack-thread-mcp-server.test.ts
│   └── slack-thread-mcp-server-root.test.ts
├── model-command/
│   ├── model-command-mcp-server.ts
│   └── model-command-mcp-server.test.ts
├── permission/
│   ├── permission-mcp-server.ts
│   └── permission-server-start.js
└── server-tools/
    ├── server-tools-mcp-server.ts    # ← NEW
    └── server-tools-mcp-server.test.ts
```

### 5.2 Import Strategy

**원칙: 물리적 분리 + 논리적 연결**

| Server | _shared/ imports | src/ imports (domain) |
|--------|-----------------|----------------------|
| llm | `../_shared/stderr-logger`, `../_shared/mcp-client` | — (none) |
| slack-thread | `../_shared/stderr-logger` | — (none) |
| model-command | `../_shared/stderr-logger` | `../../src/model-commands/*`, `../../src/types` |
| permission | `../_shared/stderr-logger` | `../../src/shared-store`, `../../src/permission/*` |
| server-tools | `../_shared/stderr-logger` | — (none, fully independent) |

**핵심 통찰**: llm, slack-thread, server-tools는 src/ 의존 없이 완전 독립. model-command, permission은 도메인 코드에 의존하므로 src/를 참조. 이 의존은 도메인 자체의 특성이지 구조의 결함이 아니다.

### 5.3 Path Resolution Change (mcp-config-builder.ts)

**Before:**
```typescript
const PERMISSION_SERVER_BASENAME = 'permission-mcp-server';
// ...
resolveInternalMcpServer(__dirname, PERMISSION_SERVER_BASENAME, runtimeExt);
// __dirname = src/ → looks for src/permission-mcp-server.ts
```

**After:**
```typescript
// Root of project = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MCP_SERVERS_DIR = path.join(PROJECT_ROOT, 'mcp-servers');

// Each server resolved from its own subdirectory
resolveInternalMcpServer(
  path.join(MCP_SERVERS_DIR, 'permission'),
  'permission-mcp-server',
  runtimeExt
);
```

### 5.4 _shared/ Contents

**stderr-logger.ts** — Copy from src/. Zero external dependencies (process.stderr only).
- src/stderr-logger.ts remains for other src/ consumers (shared-store.ts, permission/slack-messenger.ts)
- mcp-servers/_shared/stderr-logger.ts is the MCP-side copy
- 두 파일은 동일하지만 독립적으로 진화 가능

**mcp-client.ts** — Moved from src/. Only consumer was llm-mcp-server.
- Depends on Logger class from `../../src/logger.js`
- This is acceptable: mcp-client needs a logger, and Logger is a thin utility

**index.ts** — Re-exports:
```typescript
export { StderrLogger, LoggerInterface } from './stderr-logger';
export { McpClient, McpClientConfig, McpTool, McpToolResult } from './mcp-client';
```

### 5.5 server-tools-mcp-server Tools

| Tool | Input | Output | Execution |
|------|-------|--------|-----------|
| `list` | (none) | `{ servers: [{name, ssh_host, databases}] }` | Config read |
| `list_service` | `server: string` | Container list (JSON) | `ssh {host} docker ps --format json` |
| `logs` | `server, service, tail?, since?, until?, timestamps?` | Log text | `ssh {host} docker logs {opts} {svc}` |
| `db_query` | `server, database, query` | Query result rows (JSON) | SSH tunnel + mysql2 |

### 5.6 server-tools Config Schema

```json
{
  "server-tools": {
    "dev2": {
      "ssh": { "host": "dev2" },
      "databases": {
        "mydb": {
          "type": "mysql",
          "host": "127.0.0.1",
          "port": 3306,
          "user": "SA",
          "password": "SA_PASSWORD"
        }
      }
    }
  }
}
```

### 5.7 SQL Validation

```typescript
function validateReadOnlyQuery(query: string): boolean {
  const stripped = query.trim().replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const firstWord = stripped.split(/\s+/)[0]?.toUpperCase();
  const ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'DESC'];
  if (!ALLOWED.includes(firstWord)) return false;
  // Block multi-statement and file operations
  if (/;/.test(stripped.replace(/'[^']*'/g, ''))) return false;
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(stripped)) return false;
  return true;
}
```

### 5.8 Integration into mcp-config-builder.ts

```typescript
const SERVER_TOOLS_BASENAME = 'server-tools-mcp-server';

// In buildConfig(): conditionally add when config.json has server-tools
if (this.hasServerToolsConfig()) {
  internalServers['server-tools'] = this.buildServerToolsServer();
}

// In buildAllowedTools():
if (this.hasServerToolsConfig()) {
  allowedTools.push('mcp__server-tools');
}
```

## 6. Non-Functional Requirements

- **Security**: Credentials in config.json only. SELECT-only SQL. SSH key auth.
- **Performance**: SSH commands timeout 30s. DB queries timeout 60s. Config mtime-cached.
- **Reliability**: Graceful error on SSH/DB failure. No process crash on tool error.
- **Compatibility**: `npx tsx <path>` execution unchanged. No tsconfig changes needed.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Copy stderr-logger (not move) | small | src/ consumers still need it; MCP-side copy allows independent evolution |
| Move mcp-client (not copy) | small | Only consumer was llm-mcp-server; src/ no longer needs it |
| Relative imports to src/ for domain code | small | Works with npx tsx, no tooling changes, no code duplication |
| No tsconfig path aliases | tiny | Adds complexity without proportional benefit at this stage |
| No independent package.json per server | small | Future work; current monorepo npm install covers all deps |
| SERVER_TOOLS conditional injection | small | Only active when config.json has server-tools section |
| SSH for Docker (not Docker API) | small | User established pattern: ssh dev2 docker logs |
| mysql2/promise for DB queries | tiny | Standard MySQL client for Node.js |
| SSH tunnel (-L) for DB access | small | DB on remote host, consistent with SSH architecture |

## 8. Open Questions

None.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/mcp-extraction/spec.md`
