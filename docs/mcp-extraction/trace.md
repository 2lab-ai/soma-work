# MCP Server Extraction + server-tools-mcp — Vertical Trace

> STV Trace | Created: 2026-03-27
> Spec: docs/mcp-extraction/spec.md

## Table of Contents
1. [Scenario 1 — Extract _shared/ utilities](#scenario-1)
2. [Scenario 2 — Extract 4 existing MCP servers to mcp-servers/](#scenario-2)
3. [Scenario 3 — Update mcp-config-builder path resolution](#scenario-3)
4. [Scenario 4 — server-tools: config loading + infrastructure](#scenario-4)
5. [Scenario 5 — server-tools: list + list_service tools](#scenario-5)
6. [Scenario 6 — server-tools: logs tool](#scenario-6)
7. [Scenario 7 — server-tools: db_query tool + SQL validation](#scenario-7)
8. [Scenario 8 — server-tools: mcp-config-builder integration](#scenario-8)

---

## Scenario 1 — Extract _shared/ utilities

> Size: small (~20 lines new + file moves)

### 1. Entry Point
- Action: Create `mcp-servers/_shared/` directory
- Files: stderr-logger.ts (copy), mcp-client.ts (move), index.ts (new)

### 2. Input
- Source: `src/stderr-logger.ts`, `src/mcp-client.ts`
- Target: `mcp-servers/_shared/`

### 3. Layer Flow

#### 3a. stderr-logger.ts
- Copy `src/stderr-logger.ts` → `mcp-servers/_shared/stderr-logger.ts`
- Source file remains (shared-store.ts, permission/slack-messenger.ts still import it)
- Content identical; zero modifications needed (no imports to update)

#### 3b. mcp-client.ts
- Move `src/mcp-client.ts` → `mcp-servers/_shared/mcp-client.ts`
- Update import: `./logger.js` → `../../src/logger.js`
- Delete `src/mcp-client.ts`
- Only consumer (llm-mcp-server) will import from `../_shared/mcp-client.js` (updated in Scenario 2)

#### 3c. index.ts (new)
- Create barrel export:
  ```typescript
  export { StderrLogger, LoggerInterface } from './stderr-logger.js';
  export { McpClient } from './mcp-client.js';
  export type { McpClientConfig, McpTool, McpToolResult } from './mcp-client.js';
  ```

### 4. Side Effects
- New directory: `mcp-servers/_shared/`
- New file: `mcp-servers/_shared/index.ts`
- Copied file: `mcp-servers/_shared/stderr-logger.ts`
- Moved file: `src/mcp-client.ts` → `mcp-servers/_shared/mcp-client.ts`

### 5. Error Paths
| Condition | Action |
|-----------|--------|
| mcp-client.ts has other importers in src/ | Check grep; report says only llm-mcp-server imports it |

### 6. Output
- `mcp-servers/_shared/` directory with 3 files
- `src/mcp-client.ts` deleted

### 7. Observability
- N/A (structural refactor)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `shared_stderr_logger_exports` | Contract | Scenario 1, 3a — verify exports match src/ original |
| `shared_mcp_client_exports` | Contract | Scenario 1, 3b — verify McpClient class exports |
| `shared_index_reexports` | Contract | Scenario 1, 3c — verify barrel exports |

---

## Scenario 2 — Extract 4 existing MCP servers to mcp-servers/

> Size: large (~100 lines of import changes)

### 1. Entry Point
- Action: Move 4 MCP server files + test files to `mcp-servers/{name}/`
- Files affected: 9 files total (4 servers + 4 tests + 1 bootstrap)

### 2. Input

| Source | Target |
|--------|--------|
| `src/llm-mcp-server.ts` | `mcp-servers/llm/llm-mcp-server.ts` |
| `src/slack-thread-mcp-server.ts` | `mcp-servers/slack-thread/slack-thread-mcp-server.ts` |
| `src/slack-thread-mcp-server.test.ts` | `mcp-servers/slack-thread/slack-thread-mcp-server.test.ts` |
| `src/slack-thread-mcp-server-root.test.ts` | `mcp-servers/slack-thread/slack-thread-mcp-server-root.test.ts` |
| `src/model-command-mcp-server.ts` | `mcp-servers/model-command/model-command-mcp-server.ts` |
| `src/model-command-mcp-server.test.ts` | `mcp-servers/model-command/model-command-mcp-server.test.ts` |
| `src/permission-mcp-server.ts` | `mcp-servers/permission/permission-mcp-server.ts` |
| `src/permission-server-start.js` | `mcp-servers/permission/permission-server-start.js` |

### 3. Layer Flow

#### 3a. llm-mcp-server.ts
- Move to `mcp-servers/llm/`
- Import changes:
  - `./mcp-client.js` → `../_shared/mcp-client.js`
  - `./stderr-logger.js` → `../_shared/stderr-logger.js`

#### 3b. slack-thread-mcp-server.ts
- Move to `mcp-servers/slack-thread/`
- Import changes:
  - `./stderr-logger.js` → `../_shared/stderr-logger.js`

#### 3c. model-command-mcp-server.ts
- Move to `mcp-servers/model-command/`
- Import changes:
  - `./stderr-logger.js` → `../_shared/stderr-logger.js`
  - `./model-commands/catalog.js` → `../../src/model-commands/catalog.js`
  - `./model-commands/validator.js` → `../../src/model-commands/validator.js`
  - `./model-commands/types.js` → `../../src/model-commands/types.js`
  - `./types.js` → `../../src/types.js`

#### 3d. model-command-mcp-server.test.ts
- Move to `mcp-servers/model-command/`
- Import changes:
  - `./model-command-mcp-server` → `./model-command-mcp-server`  (same dir, no change)
  - `./model-commands/validator` → `../../src/model-commands/validator`

#### 3e. permission-mcp-server.ts
- Move to `mcp-servers/permission/`
- Import changes:
  - `./stderr-logger.js` → `../_shared/stderr-logger.js`
  - `./shared-store.js` → `../../src/shared-store.js`
  - `./permission/index.js` → `../../src/permission/index.js`

#### 3f. permission-server-start.js
- Move to `mcp-servers/permission/`
- Change: `require('./permission-mcp-server.ts')` → `require('./permission-mcp-server.ts')` (same dir, no change)

#### 3g. slack-thread-mcp-server.test.ts
- Move to `mcp-servers/slack-thread/`
- Import changes: update relative paths as needed

#### 3h. slack-thread-mcp-server-root.test.ts
- Move to `mcp-servers/slack-thread/`
- Import changes: source path reference `path.join(__dirname, 'slack-thread-mcp-server.ts')` → stays same (same dir)

### 4. Side Effects
- 9 files moved
- 9 source files deleted from `src/`
- All old import paths no longer exist

### 5. Error Paths
| Condition | Action |
|-----------|--------|
| Other files import moved servers | Grep shows NO direct imports (standalone processes) |
| Test runner can't find moved tests | Update vitest config if pattern excludes mcp-servers/ |
| String references break | mcp-config-builder.ts uses basename strings → updated in Scenario 3 |

### 6. Output
- `mcp-servers/llm/`, `mcp-servers/slack-thread/`, `mcp-servers/model-command/`, `mcp-servers/permission/` directories populated
- All old server files removed from `src/`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `extracted_llm_server_imports_resolve` | Contract | Scenario 2, 3a — verify _shared imports |
| `extracted_model_command_src_imports_resolve` | Contract | Scenario 2, 3c — verify ../../src/ imports |
| `extracted_permission_src_imports_resolve` | Contract | Scenario 2, 3e — verify shared-store + permission/ imports |
| `no_mcp_server_files_in_src` | Side-Effect | Scenario 2, 4 — verify old files deleted |

---

## Scenario 3 — Update mcp-config-builder path resolution

> Size: medium (~50 lines)

### 1. Entry Point
- File: `src/mcp-config-builder.ts`
- Action: Change server path resolution from `__dirname` to `mcp-servers/` subdirectories

### 2. Input
- Current: `resolveInternalMcpServer(__dirname, basename, ext)`
- Target: `resolveInternalMcpServer(path.join(MCP_SERVERS_DIR, subdir), basename, ext)`

### 3. Layer Flow

#### 3a. Add MCP_SERVERS_DIR constant
```typescript
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MCP_SERVERS_DIR = path.join(PROJECT_ROOT, 'mcp-servers');
```

#### 3b. Update resolveServerPath method
- Change `resolveInternalMcpServer(__dirname, basename, ...)` to use server-specific subdirectories
- `PERMISSION_SERVER_BASENAME` → `path.join(MCP_SERVERS_DIR, 'permission')`
- `MODEL_COMMAND_SERVER_BASENAME` → `path.join(MCP_SERVERS_DIR, 'model-command')`
- `LLM_SERVER_BASENAME` → `path.join(MCP_SERVERS_DIR, 'llm')`
- `SLACK_THREAD_SERVER_BASENAME` → `path.join(MCP_SERVERS_DIR, 'slack-thread')`

#### 3c. Update server cache initialization
- Each cache's `resolveServerPath()` call passes the new subdirectory path

#### 3d. Update mcp-config-builder.test.ts
- Test paths change from `/app/dist/permission-mcp-server.js` pattern to `/app/mcp-servers/permission/permission-mcp-server.js`

### 4. Side Effects
- Path resolution logic changes globally
- All 4 server cache methods affected

### 5. Error Paths
| Condition | Error |
|-----------|-------|
| MCP_SERVERS_DIR doesn't exist at runtime | resolveInternalMcpServer returns null → existing error logging handles it |
| __dirname confusion in dist/ vs src/ | runtimeExt detection (.ts vs .js) handles both cases |

### 6. Output
- `mcp-config-builder.ts` resolves server paths from `mcp-servers/{name}/`
- All existing config builder tests updated and passing

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `config_builder_resolves_from_mcp_servers_dir` | Contract | Scenario 3, 3b — verify new path resolution |
| `config_builder_llm_server_path` | Happy Path | Scenario 3, 3b — resolve llm server path |
| `config_builder_permission_server_path` | Happy Path | Scenario 3, 3b — resolve permission server path |
| `config_builder_handles_missing_mcp_servers_dir` | Sad Path | Scenario 3, 5 — null when dir missing |

---

## Scenario 4 — server-tools: config loading + infrastructure

> Size: medium (~50 lines)

### 1. MCP Entry
- Tool: N/A (internal infrastructure)
- File: `mcp-servers/server-tools/server-tools-mcp-server.ts`

### 2. Input
- Env: `SOMA_CONFIG_FILE` → path to config.json
- Config section: `server-tools` in config.json

### 3. Layer Flow

#### 3a. Config types
```typescript
interface ServerToolsConfig {
  [serverName: string]: {
    ssh: { host: string };
    databases?: {
      [dbName: string]: {
        type: 'mysql';
        host: string;
        port: number;
        user: string;
        password: string;
      };
    };
  };
}
```
Config read from SOMA_CONFIG_FILE env → JSON.parse → `.["server-tools"]` section.

#### 3b. Mtime-based caching
- Pattern: identical to llm-mcp-server.ts
- `loadConfig()` checks `fs.statSync(configFile).mtimeMs` and `size`
- Re-reads only when changed
- Env.SOMA_CONFIG_FILE → config.json path → `cachedConfig.serverTools`

#### 3c. SQL validation function
```
Input: raw query string
→ Strip block comments (/* */)
→ Trim whitespace
→ Extract first word → .toUpperCase()
→ Check against ALLOWED=['SELECT','SHOW','DESCRIBE','EXPLAIN','DESC']
→ Check no semicolons outside string literals
→ Check no INTO OUTFILE/DUMPFILE
→ Return boolean
```

### 4. Side Effects
- None (reads config, no mutations)

### 5. Error Paths
| Condition | Error |
|-----------|-------|
| Config file doesn't exist | Return empty config (no servers available) |
| server-tools section missing | Return empty config |
| Invalid JSON | Keep cached config, log warning |

### 6. Output
- ServerToolsConfig object available to all tool handlers

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `config_loads_server_tools_section` | Happy Path | Scenario 4, 3a-3b |
| `config_returns_empty_when_no_section` | Sad Path | Scenario 4, 5 |
| `config_mtime_cache_avoids_reread` | Contract | Scenario 4, 3b |
| `sql_allows_select` | Happy Path | Scenario 4, 3c |
| `sql_allows_show_describe_explain` | Happy Path | Scenario 4, 3c |
| `sql_blocks_insert` | Sad Path | Scenario 4, 3c |
| `sql_blocks_update` | Sad Path | Scenario 4, 3c |
| `sql_blocks_delete` | Sad Path | Scenario 4, 3c |
| `sql_blocks_drop` | Sad Path | Scenario 4, 3c |
| `sql_blocks_multi_statement` | Sad Path | Scenario 4, 3c — semicolon detection |
| `sql_blocks_into_outfile` | Sad Path | Scenario 4, 3c |
| `sql_allows_semicolon_in_string_literal` | Contract | Scenario 4, 3c |

---

## Scenario 5 — server-tools: list + list_service tools

> Size: medium (~50 lines)

### 1. MCP Entry
- Tool: `list` — no args
- Tool: `list_service` — `{ server: string }`

### 2. Input
- `list`: none
- `list_service`: `server` (required, must match config key)

### 3. Layer Flow

#### 3a. list tool
```
MCP CallTool("list", {})
→ loadConfig()
→ Object.entries(config) → map to [{name, ssh_host, databases: [...names]}]
→ Return JSON
```

#### 3b. list_service tool
```
MCP CallTool("list_service", {server: "dev2"})
→ loadConfig()
→ config["dev2"] ?? throw "Unknown server"
→ execFileSync("ssh", [config.ssh.host, "docker", "ps", "--format", "json"], {timeout: 30000})
→ Parse JSON lines (docker ps --format json outputs one JSON per line)
→ Return array of {name, image, status, ports, created}
```

Transformation:
- `args.server` → `config[server].ssh.host` → `ssh {host} docker ps --format json`
- Docker JSON output → parsed container objects → MCP response text

### 4. Side Effects
- list: none (read-only)
- list_service: SSH connection to remote host

### 5. Error Paths
| Condition | Error | Response |
|-----------|-------|----------|
| Unknown server name | `Unknown server: {name}` | isError: true |
| SSH connection failed | `SSH connection failed: {stderr}` | isError: true |
| SSH timeout (>30s) | `Command timed out` | isError: true |
| No containers running | Empty array | isError: false |

### 6. Output
- list: `{ servers: [{name: "dev2", ssh_host: "dev2", databases: ["mydb"]}] }`
- list_service: `{ containers: [{name, image, status, ports}] }`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `list_returns_configured_servers` | Happy Path | Scenario 5, 3a |
| `list_returns_empty_when_no_config` | Sad Path | Scenario 5, 3a |
| `list_service_calls_docker_ps_via_ssh` | Contract | Scenario 5, 3b — verify SSH command construction |
| `list_service_unknown_server_errors` | Sad Path | Scenario 5, 5 |
| `list_service_ssh_failure_errors` | Sad Path | Scenario 5, 5 |

---

## Scenario 6 — server-tools: logs tool

> Size: medium (~50 lines)

### 1. MCP Entry
- Tool: `logs`
- Args: `{ server: string, service: string, tail?: number, since?: string, until?: string, timestamps?: boolean }`

### 2. Input
- `server` (required): config key
- `service` (required): container/service name
- `tail` (optional): number of lines (default: 100)
- `since` (optional): timestamp or relative (e.g. "1h", "2024-01-01")
- `until` (optional): timestamp or relative
- `timestamps` (optional): boolean, adds --timestamps flag

### 3. Layer Flow

```
MCP CallTool("logs", {server:"dev2", service:"gucci-gucci_service-1", tail:50, timestamps:true})
→ loadConfig()
→ config["dev2"] ?? throw "Unknown server"
→ Build args array:
    ["ssh", config.ssh.host, "docker", "logs"]
    + (tail ? ["--tail", String(tail)] : ["--tail", "100"])
    + (since ? ["--since", since] : [])
    + (until ? ["--until", until] : [])
    + (timestamps ? ["--timestamps"] : [])
    + [service]
→ execFileSync("ssh", argsArray, {timeout: 30000, maxBuffer: 1024*1024})
→ Return stdout as text
```

Transformation:
- `args.server` → `config[server].ssh.host`
- `args.service` → appended as last docker logs argument
- `args.tail` → `--tail {n}` (default 100)
- `args.since` → `--since {value}`
- `args.until` → `--until {value}`
- `args.timestamps` → `--timestamps`
- Combined: `ssh {host} docker logs --tail {n} [--since ...] [--until ...] [--timestamps] {service}`

### 4. Side Effects
- SSH connection to remote host (read-only)

### 5. Error Paths
| Condition | Error | Response |
|-----------|-------|----------|
| Unknown server | `Unknown server: {name}` | isError: true |
| Unknown container | Docker stderr: "No such container" | isError: true |
| SSH timeout | `Command timed out` | isError: true |
| Output too large | maxBuffer exceeded → truncate + warning | isError: false |

### 6. Output
- Log text as MCP text content

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `logs_builds_correct_ssh_command` | Contract | Scenario 6, 3 — args construction |
| `logs_applies_tail_default_100` | Contract | Scenario 6, 3 — default tail |
| `logs_applies_all_options` | Contract | Scenario 6, 3 — since, until, timestamps |
| `logs_unknown_server_errors` | Sad Path | Scenario 6, 5 |
| `logs_unknown_container_errors` | Sad Path | Scenario 6, 5 |

---

## Scenario 7 — server-tools: db_query tool + SQL validation

> Size: medium (~50 lines)

### 1. MCP Entry
- Tool: `db_query`
- Args: `{ server: string, database: string, query: string }`

### 2. Input
- `server` (required): config key
- `database` (required): database name (must match config databases key)
- `query` (required): SQL query (SELECT only)

### 3. Layer Flow

```
MCP CallTool("db_query", {server:"dev2", database:"mydb", query:"SELECT * FROM users LIMIT 10"})
→ loadConfig()
→ config["dev2"] ?? throw "Unknown server"
→ config["dev2"].databases["mydb"] ?? throw "Unknown database"
→ validateReadOnlyQuery(query) ?? throw "Only SELECT/SHOW/DESCRIBE/EXPLAIN allowed"
→ Open SSH tunnel: ssh -L {localPort}:{dbHost}:{dbPort} {sshHost} -N &
→ Connect mysql2: createConnection({host:"127.0.0.1", port:localPort, user, password, database})
→ Execute query with timeout (60s)
→ Close connection + kill SSH tunnel
→ Return rows as JSON
```

Transformation:
- `args.server` → `config[server].ssh.host` → SSH tunnel source
- `args.database` → `config[server].databases[database]` → {host, port, user, password}
- `args.query` → validated → executed via mysql2
- MySQL result rows → JSON stringified → MCP text content

### 4. Side Effects
- SSH tunnel created/destroyed (ephemeral)
- MySQL connection opened/closed
- Query executed on remote database (read-only)

### 5. Error Paths
| Condition | Error | Response |
|-----------|-------|----------|
| Unknown server | `Unknown server: {name}` | isError: true |
| Unknown database | `Unknown database: {name} on {server}` | isError: true |
| Non-SELECT query | `Only SELECT/SHOW/DESCRIBE/EXPLAIN queries allowed` | isError: true |
| SSH tunnel failure | `Failed to establish SSH tunnel to {host}` | isError: true |
| MySQL connection error | `Database connection failed: {message}` | isError: true |
| Query timeout (>60s) | `Query timed out after 60s` | isError: true |
| Query syntax error | MySQL error message forwarded | isError: true |

### 6. Output
- `{ columns: [...], rows: [...], rowCount: N }`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `db_query_validates_select_only` | Contract | Scenario 7, 3 — validateReadOnlyQuery gate |
| `db_query_opens_ssh_tunnel` | Contract | Scenario 7, 3 — SSH tunnel construction |
| `db_query_returns_rows_as_json` | Happy Path | Scenario 7, 6 |
| `db_query_unknown_server_errors` | Sad Path | Scenario 7, 5 |
| `db_query_unknown_database_errors` | Sad Path | Scenario 7, 5 |
| `db_query_non_select_rejected` | Sad Path | Scenario 7, 5 |
| `db_query_closes_tunnel_on_error` | Side-Effect | Scenario 7, 4 — cleanup |

---

## Scenario 8 — server-tools: mcp-config-builder integration

> Size: small (~20 lines)

### 1. Entry Point
- File: `src/mcp-config-builder.ts`
- Action: Add server-tools as conditional internal server

### 2. Input
- Config.json must have `server-tools` section
- SOMA_CONFIG_FILE env must be set

### 3. Layer Flow

#### 3a. Add basename constant
```typescript
const SERVER_TOOLS_BASENAME = 'server-tools-mcp-server';
```

#### 3b. Add hasServerToolsConfig() method
```typescript
private hasServerToolsConfig(): boolean {
  // Read config.json (or use unified config loader)
  // Return true if server-tools section exists and has at least one server
}
```

Config detection: `SOMA_CONFIG_FILE` env → `JSON.parse(fs.readFileSync())` → `?.["server-tools"]` → `Object.keys().length > 0`

#### 3c. Add buildServerToolsServer() method
```typescript
private buildServerToolsServer(): Record<string, any> {
  const serverPath = this.getServerToolsServerPath();
  return {
    command: 'npx',
    args: ['tsx', serverPath],
    env: {
      SOMA_CONFIG_FILE: CONFIG_FILE,
    },
  };
}
```

#### 3d. Wire into buildConfig() + buildAllowedTools()
- In `buildConfig()`: `if (this.hasServerToolsConfig()) internalServers['server-tools'] = this.buildServerToolsServer()`
- In `buildAllowedTools()`: `if (this.hasServerToolsConfig()) allowedTools.push('mcp__server-tools')`

### 4. Side Effects
- server-tools MCP server spawned as child process when config present

### 5. Error Paths
| Condition | Action |
|-----------|--------|
| Config file missing | hasServerToolsConfig returns false → server not added |
| server-tools section empty | hasServerToolsConfig returns false → server not added |
| Server path not found | Existing error handling (log + skip) |

### 6. Output
- `mcp-config-builder.ts` conditionally adds server-tools server

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `config_builder_adds_server_tools_when_configured` | Happy Path | Scenario 8, 3d |
| `config_builder_skips_server_tools_when_no_config` | Sad Path | Scenario 8, 5 |
| `config_builder_allows_server_tools_mcp_tool` | Contract | Scenario 8, 3d — allowedTools |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Test files co-located with servers in mcp-servers/ | tiny | Follows project convention |
| vitest config may need include pattern update | small | Check if vitest.config.ts pattern already covers mcp-servers/ |
| SSH tunnel for DB uses random ephemeral port | tiny | Avoids port conflicts |
| Docker ps --format json for structured output | tiny | Reliable parsing vs text parsing |
| Default tail=100 for logs | tiny | Reasonable default, not too verbose |
| maxBuffer 1MB for log output | small | Prevents memory issues from large logs |

## Implementation Status

| Scenario | Trace | Tests (RED) | Size | Status |
|----------|-------|-------------|------|--------|
| 1. Extract _shared/ utilities | done | RED | small | Ready |
| 2. Extract 4 MCP servers | done | RED | large | Ready |
| 3. Update config-builder paths | done | RED | medium | Ready |
| 4. server-tools config + infra | done | RED | medium | Ready |
| 5. server-tools list + list_service | done | RED | medium | Ready |
| 6. server-tools logs | done | RED | medium | Ready |
| 7. server-tools db_query + SQL | done | RED | medium | Ready |
| 8. server-tools config-builder integration | done | RED | small | Ready |

## Next Step
→ Proceed with implementation via `stv:do-work`
