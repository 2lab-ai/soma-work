# MCP Servers Refactoring — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/mcp-refactor/spec.md

## Table of Contents
1. [Scenario 1 — BaseMcpServer extraction](#scenario-1)
2. [Scenario 2 — ConfigCache extraction](#scenario-2)
3. [Scenario 3 — Error handling standardization](#scenario-3)
4. [Scenario 4 — slack-mcp decomposition](#scenario-4)
5. [Scenario 5 — McpConfigBuilder registry pattern](#scenario-5)

---

## Scenario 1 — BaseMcpServer extraction

### 1. Entry Point
- File: `mcp-servers/_shared/base-mcp-server.ts` (NEW)
- Consumers: all 5 server files

### 2. Input (Interface Contract)
```typescript
abstract class BaseMcpServer {
  constructor(name: string, version?: string)
  abstract defineTools(): ToolDefinition[]
  abstract handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult>
  run(): Promise<void>           // Server + StdioTransport + connect + signals
  formatError(tool: string, error: unknown): ToolErrorResult
  shutdown(): Promise<void>      // cleanup hook (overridable)
}
```

### 3. Layer Flow

#### 3a. Base class creation
- NEW file: `mcp-servers/_shared/base-mcp-server.ts`
- Extracts from: all 5 servers' identical constructor + setupHandlers + run patterns
- Transformation:
  - Server instantiation → `BaseMcpServer.constructor(name, version)`
  - `setRequestHandler(ListToolsRequestSchema)` → delegates to `this.defineTools()`
  - `setRequestHandler(CallToolRequestSchema)` → delegates to `this.handleTool()` with try/catch
  - `new StdioServerTransport() + server.connect()` → `BaseMcpServer.run()`
  - `process.on('SIGINT'/'SIGTERM')` → `BaseMcpServer.run()` registers once

#### 3b. Server migration (each server)
- llm: `class LlmMCPServer` → `extends BaseMcpServer`, remove boilerplate, keep `handleChat`/`handleChatReply` + session tracking
- model-command: `class ModelCommandMcpServer` → `extends BaseMcpServer`, keep context parsing + list/run handlers
- permission: `class PermissionMCPServer` → `extends BaseMcpServer`, keep `handlePermissionPrompt` + approval logic
- server-tools: `class ServerToolsMCPServer` → `extends BaseMcpServer`, keep tool handlers (already exported)
- slack-mcp: `class SlackMcpServer` → `extends BaseMcpServer`, keep per-tool handlers (decomposed in Scenario 4)

### 4. Side Effects
- NEW file: `mcp-servers/_shared/base-mcp-server.ts` (~80 lines)
- MODIFY: 5 server files (remove ~30 lines boilerplate each, add `extends BaseMcpServer`)
- UPDATE: `mcp-servers/_shared/index.ts` (add export)

### 5. Error Paths
- None — pure structural refactoring

### 6. Output (Behavioral Contract)
- All servers' tool lists remain identical
- All servers' tool call responses remain identical
- All servers' error responses follow same format

### 7. Observability
- Logger context preserved per-server (name passed to constructor)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `BaseMcpServer_defineTools_called_on_list` | Contract | Scenario 1, Section 3a |
| `BaseMcpServer_handleTool_dispatches_correctly` | Happy Path | Scenario 1, Section 3a |
| `BaseMcpServer_formatError_returns_consistent_shape` | Contract | Scenario 1, Section 3a |
| `BaseMcpServer_unknown_tool_returns_error` | Sad Path | Scenario 1, Section 3a |

---

## Scenario 2 — ConfigCache extraction

### 1. Entry Point
- File: `mcp-servers/_shared/config-cache.ts` (NEW)
- Consumers: llm-mcp-server.ts, server-tools-mcp-server.ts

### 2. Input (Interface Contract)
```typescript
class ConfigCache<T> {
  constructor(defaultValue: T, options: { section: string; loader: (raw: any) => T | null })
  get(): T              // mtime check → reload if changed
  reset(): void         // for testing
}
```

### 3. Layer Flow

#### 3a. Extraction
- FROM llm-mcp-server.ts: lines 38-80 (loadConfig, cachedConfig, cachedMtimeMs, cachedSize)
- FROM server-tools-mcp-server.ts: lines 31-71 (loadConfig, resetConfigCache, cachedConfig, cachedMtimeMs, cachedSize)
- Transformation:
  - `cachedConfig` + `cachedMtimeMs` + `cachedSize` → `ConfigCache` instance state
  - `loadConfig()` → `ConfigCache.get()`
  - `resetConfigCache()` → `ConfigCache.reset()`
  - `SOMA_CONFIG_FILE` env read → shared in `ConfigCache.get()`
  - Section-specific parsing (llm: `raw.llmChat`, server-tools: `raw['server-tools']`) → `options.loader` callback

#### 3b. Consumer migration
- _(REMOVED in #639: the llm ConfigCache consumer is gone — `llmChat` section,
  `HARDCODED_DEFAULTS`, and `parseLlmConfig` were all deleted together with the
  llmChatConfigStore subsystem.)_
- server-tools: `const serverToolsConfigCache = new ConfigCache({}, { section: 'server-tools', loader: parseServerToolsConfig })`

### 4. Side Effects
- NEW file: `mcp-servers/_shared/config-cache.ts` (~50 lines)
- MODIFY: llm-mcp-server.ts (remove ~40 lines, add ~5 lines)
- MODIFY: server-tools-mcp-server.ts (remove ~40 lines, add ~5 lines)
- UPDATE: `mcp-servers/_shared/index.ts` (add export)

### 5. Error Paths
- File not found / invalid JSON → return cached default (same as current behavior)

### 6. Output (Behavioral Contract)
- `configCache.get()` returns same values as current `loadConfig()` for identical config files
- mtime caching behavior identical

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `ConfigCache_returns_default_when_no_file` | Happy Path | Scenario 2, Section 3a |
| `ConfigCache_loads_from_file_on_first_call` | Happy Path | Scenario 2, Section 3a |
| `ConfigCache_caches_by_mtime` | Contract | Scenario 2, Section 3a |
| `ConfigCache_reloads_on_mtime_change` | Contract | Scenario 2, Section 3a |
| `ConfigCache_reset_clears_cache` | Happy Path | Scenario 2, Section 3a |
| `ConfigCache_survives_invalid_json` | Sad Path | Scenario 2, Section 5 |

---

## Scenario 3 — Error handling standardization

### 1. Entry Point
- Integrated into `BaseMcpServer.formatError()` (Scenario 1)
- slack-mcp gets enhanced error format preserved via override

### 2. Input
- Current formats across servers:
  - llm/server-tools/model-command: `{ content: [{type:'text', text: 'Error: msg'}], isError: true }`
  - slack-mcp: `{ content: [{type:'text', text: JSON.stringify({error, slack_error, retryable, hint})}], isError: true }`

### 3. Layer Flow
- Base: `formatError()` produces standard `{ content: [{type:'text', text: 'Error: msg'}], isError: true }`
- slack-mcp: overrides `formatError()` to produce enriched JSON with `slack_error`, `retryable`, `hint` fields
- No other servers need override

### 4. Side Effects
- Covered by Scenario 1 (base class) + Scenario 4 (slack-mcp decomposition)

### 5. Error Paths
- N/A (this IS the error path standardization)

### 6. Output
- Standard error shape from base: `{ content: [{type:'text', text: 'Error: {message}'}], isError: true }`
- Slack-mcp enriched shape preserved exactly

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `formatError_standard_shape` | Contract | Scenario 3, Section 3 |
| `formatError_slack_enriched_shape` | Contract | Scenario 3, Section 3 |

---

## Scenario 4 — slack-mcp decomposition

### 1. Entry Point
- File: `mcp-servers/slack-mcp/slack-mcp-server.ts` (954 lines → ~150 lines)
- New files in `mcp-servers/slack-mcp/`

### 2. Input
- 4 tools: get_thread_messages, download_thread_file, send_file, send_media

### 3. Layer Flow

#### 3a. Module extraction
- `types.ts`: SlackMcpContext, ThreadMessage, ThreadFile, GetThreadMessagesResult, constants
- `helpers/file-validator.ts`: validateFilePath, isImageFile, isMediaFile, getMediaType, ALLOWED_* sets
- `helpers/message-formatter.ts`: formatSingleMessage
- `helpers/thread-fetcher.ts`: getTotalCount, fetchThreadSlice, fetchMessagesBefore, fetchMessagesAfter, extractCursor
- `handlers/thread-messages.ts`: handleGetThreadMessages (array mode + legacy mode)
- `handlers/download-file.ts`: handleDownloadFile
- `handlers/upload-file.ts`: handleSendFile, handleSendMedia

#### 3b. Server class
- `slack-mcp-server.ts`: SlackMcpServer extends BaseMcpServer
  - constructor: parse env vars, create WebClient
  - defineTools(): return tool definitions
  - handleTool(): dispatch to handlers
  - formatError(): override with enriched Slack error shape

### 4. Side Effects
- NEW: 6 files (types + 3 helpers + 2 handler files)
- MODIFY: slack-mcp-server.ts (954 → ~150 lines)
- Existing test files: import paths may change

### 5. Error Paths
- Preserved exactly (slack-mcp's enriched error format via formatError override)

### 6. Output
- All 4 tools produce identical responses

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `validateFilePath_rejects_traversal` | Sad Path | Scenario 4, Section 3a |
| `validateFilePath_rejects_symlinks` | Sad Path | Scenario 4, Section 3a |
| `validateFilePath_accepts_valid_tmp_file` | Happy Path | Scenario 4, Section 3a |
| `isMediaFile_classifies_correctly` | Contract | Scenario 4, Section 3a |
| `formatSingleMessage_produces_correct_shape` | Contract | Scenario 4, Section 3a |

---

## Scenario 5 — McpConfigBuilder registry pattern

### 1. Entry Point
- File: `src/mcp-config-builder.ts`

### 2. Input
- Current: 5 individual cache fields + 5 getter methods
- Target: 1 Map + 1 generic getter

### 3. Layer Flow
- Replace 5 `*Cache` fields with `private serverPathRegistry = new Map<string, PathCache>()`
- Replace 5 `get*ServerPath()` methods with single `private getServerPath(label, basename, serverDir): string`
- Each `build*Server()` method calls `this.getServerPath(...)` instead of dedicated getter

### 4. Side Effects
- MODIFY: `src/mcp-config-builder.ts` (remove ~30 lines, add ~10 lines)

### 5. Error Paths
- Same as current: throws if server file not found

### 6. Output
- Identical MCP server configurations produced

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `McpConfigBuilder_registry_resolves_all_servers` | Happy Path | Scenario 5, Section 3 |
| `McpConfigBuilder_registry_caches_on_second_call` | Contract | Scenario 5, Section 3 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| BaseMcpServer uses abstract class (not interface+helpers) | small | 5 servers share identical lifecycle; inheritance eliminates 150+ lines of duplication. Composition alternative is ~20 lines more per server |
| ConfigCache uses generic class with loader callback | tiny | Only difference between llm and server-tools caching is the JSON section key and parser |
| slack-mcp handlers receive dependencies via constructor injection | small | Handlers need WebClient + token + context. Passing as constructor args to handler classes, not globals |
| Keep existing test files, add new tests for extracted modules | tiny | Existing tests validate behavioral correctness; new tests validate extracted module contracts |
| formatError override for slack-mcp only | tiny | Only slack-mcp has enriched error format; other 4 servers use identical simple format |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. BaseMcpServer extraction | done | RED | Ready for stv:work |
| 2. ConfigCache extraction | done | RED | Ready for stv:work |
| 3. Error handling standardization | done | RED | Ready for stv:work |
| 4. slack-mcp decomposition | done | RED | Ready for stv:work |
| 5. McpConfigBuilder registry pattern | done | RED | Ready for stv:work |

## Next Step
→ Proceed with implementation via `stv:do-work`
