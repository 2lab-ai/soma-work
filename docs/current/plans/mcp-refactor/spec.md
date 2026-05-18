# MCP Servers Refactoring — Spec

> STV Spec | Created: 2026-03-28

## 1. Overview

soma-work의 `mcp-servers/` 디렉토리에 5개의 MCP 서버가 각각 독립 파일로 존재하며, 동일한 boilerplate(Server 생성, Transport 연결, ListTools/CallTool 핸들러 등록, 에러 처리, 시그널 핸들링)를 반복하고 있다. config 캐싱 로직도 llm과 server-tools에 중복되고, slack-mcp-server.ts는 954줄 단일 파일로 유지보수가 곤란하다.

이 리팩토링의 목적: **중복 제거로 변경 비용을 1/5로 줄이고, 새 MCP 서버 추가 시 boilerplate 없이 도구 정의만으로 서버를 만들 수 있게 한다.**

## 2. User Stories

- As a **developer**, I want a common base class for MCP servers, so that new servers require only tool definitions without boilerplate.
- As a **developer**, I want unified config caching, so that config loading logic exists in one place.
- As a **developer**, I want standardized error handling, so that all MCP servers return consistent error responses.
- As a **developer**, I want slack-mcp decomposed into focused modules, so that each concern is testable independently.
- As a **developer**, I want McpConfigBuilder's path resolution simplified, so that adding a new internal server doesn't require copy-pasting cache boilerplate.

## 3. Acceptance Criteria

- [ ] All 5 MCP servers extend a common `BaseMcpServer` class from `_shared/`
- [ ] `BaseMcpServer` handles: Server creation, StdioTransport, ListTools/CallTool dispatch, error formatting, signal cleanup
- [ ] Config caching (mtime-based) extracted to `_shared/config-cache.ts`, used by llm + server-tools
- [ ] Error responses use a single `formatToolError()` helper with consistent JSON shape
- [ ] `slack-mcp-server.ts` decomposed: core server <300 lines, handlers in separate files
- [ ] McpConfigBuilder uses a registry/map pattern instead of 5 individual cache fields
- [ ] All existing tests pass (`npx vitest run`)
- [ ] No behavioral changes — pure refactoring (input/output contracts identical)

## 4. Scope

### In-Scope
- `mcp-servers/_shared/` — new base class, config cache, error helpers
- `mcp-servers/llm/llm-mcp-server.ts` — extend base class, use shared config cache
- `mcp-servers/model-command/model-command-mcp-server.ts` — extend base class
- `mcp-servers/permission/permission-mcp-server.ts` — extend base class
- `mcp-servers/server-tools/server-tools-mcp-server.ts` — extend base class, use shared config cache
- `mcp-servers/slack-mcp/` — decompose into handler modules + extend base class
- `src/mcp-config-builder.ts` — simplify path resolution with registry pattern

### Out-of-Scope
- MCP client (`_shared/mcp-client.ts`) — already well-structured
- `src/mcp-manager.ts`, `src/mcp/config-loader.ts`, `src/mcp/server-factory.ts` — no changes needed
- Adding new MCP servers
- Changing any tool's input/output contract
- Test infrastructure changes

## 5. Architecture

### 5.1 Layer Structure

```
BaseMcpServer (abstract)          ← NEW: _shared/base-mcp-server.ts
  ├── abstract defineTools()      ← Each server implements this
  ├── abstract handleTool()       ← Each server implements this
  ├── run()                       ← Shared: Server + Transport + connect
  ├── formatError()               ← Shared: consistent error response
  └── cleanup()                   ← Shared: SIGINT/SIGTERM handling

ConfigCache<T>                    ← NEW: _shared/config-cache.ts
  ├── constructor(loader)
  ├── get(): T                    ← mtime-check, reload if changed
  └── reset()                     ← for testing
```

### 5.2 BaseMcpServer Design

```typescript
// _shared/base-mcp-server.ts
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export abstract class BaseMcpServer {
  protected server: Server;
  protected logger: StderrLogger;

  constructor(name: string, version: string = '1.0.0') {
    this.logger = new StderrLogger(name);
    this.server = new Server(
      { name, version },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
  }

  protected abstract defineTools(): ToolDefinition[];
  protected abstract handleTool(name: string, args: Record<string, unknown>): Promise<any>;

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.defineTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      this.logger.debug(`Tool call: ${name}`, args);
      try {
        return await this.handleTool(name, args as Record<string, unknown>);
      } catch (error) {
        return this.formatError(name, error);
      }
    });
  }

  protected formatError(toolName: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Tool ${toolName} failed`, error);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info(`${this.server.name} started`);
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  protected async shutdown(): Promise<void> {
    this.logger.info('Shutting down...');
    process.exit(0);
  }
}
```

### 5.3 ConfigCache Design

```typescript
// _shared/config-cache.ts
export class ConfigCache<T> {
  private cached: T;
  private mtimeMs = 0;
  private size = 0;

  constructor(
    private defaultValue: T,
    private loader: (raw: any) => T | null,
    private configSection: string
  ) {
    this.cached = defaultValue;
  }

  get(): T {
    const configFile = process.env.SOMA_CONFIG_FILE || '';
    if (!configFile) return this.cached;
    // mtime check + reload logic (extracted from llm + server-tools)
    ...
    return this.cached;
  }

  reset(): void { /* for testing */ }
}
```

### 5.4 slack-mcp Decomposition

```
mcp-servers/slack-mcp/
  ├── slack-mcp-server.ts          ← Server class only (~150 lines)
  ├── handlers/
  │   ├── thread-messages.ts       ← get_thread_messages (array + legacy)
  │   ├── download-file.ts         ← download_thread_file
  │   └── upload-file.ts           ← send_file + send_media
  ├── helpers/
  │   ├── message-formatter.ts     ← formatSingleMessage
  │   ├── file-validator.ts        ← validateFilePath, media checks
  │   └── thread-fetcher.ts        ← getTotalCount, fetchThreadSlice, fetchBefore/After
  └── types.ts                     ← interfaces (SlackMcpContext, ThreadMessage, etc.)
```

### 5.5 McpConfigBuilder Simplification

현재 5개의 개별 캐시 필드 + getter를 **레지스트리 맵**으로 통합:

```typescript
// Before: 5 individual caches
private permissionServerCache = McpConfigBuilder.emptyCache();
private modelCommandServerCache = McpConfigBuilder.emptyCache();
private slackMcpServerCache = McpConfigBuilder.emptyCache();
private llmServerCache = McpConfigBuilder.emptyCache();
private serverToolsCache = McpConfigBuilder.emptyCache();

// After: single registry
private serverPathRegistry = new Map<string, { path: string | null; checked: boolean; triedPaths: string[] }>();

private getServerPath(label: string, basename: string, serverDir: string): string {
  if (!this.serverPathRegistry.has(basename)) {
    this.serverPathRegistry.set(basename, { path: null, checked: false, triedPaths: [] });
  }
  return this.resolveServerPath(label, basename, serverDir, this.serverPathRegistry.get(basename)!);
}
```

### 5.6 Integration Points

- `src/mcp-config-builder.ts` — server path 빌드 (변경 대상)
- `src/mcp-manager.ts` — 변경 없음 (facade만 사용)
- 기존 테스트 파일들 — import 경로 변경 가능성

## 6. Non-Functional Requirements

- **Performance**: 없음 (리팩토링, 런타임 동작 동일)
- **Security**: 없음 (외부 인터페이스 변경 없음)
- **Backwards Compatibility**: 모든 MCP 서버의 tool name, input schema, output format 100% 동일 유지

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 상속(BaseMcpServer) vs 합성(helper functions) → **상속** 선택 | small | 5개 서버 모두 동일한 lifecycle(init→register→run→cleanup)을 공유. 상속이 boilerplate 제거에 가장 효과적. 합성으로 전환 시 ~20줄 변경 |
| ConfigCache를 generic class로 → **Yes** | tiny | llm과 server-tools의 캐싱 로직이 구조적으로 동일, section key만 다름 |
| slack-mcp 분해 단위 → **handlers/ + helpers/ + types.ts** | small | 기존 코드의 주석 섹션 구분(`── get_thread_messages ──` 등)이 자연스러운 모듈 경계 |
| 에러 응답 형식 → **기존 `{ content: [{type:'text', text: 'Error: ...'}], isError: true }` 유지** | tiny | 4/5 서버가 이미 이 형식 사용. slack-mcp만 약간 다르지만 기존 형식에 맞춤 |
| McpConfigBuilder 캐시 → **Map registry** | tiny | 5개 필드+getter를 1개 Map+1개 메서드로 축소. 순수 중복 제거 |

## 8. Open Questions

None — 순수 리팩토링이므로 비즈니스 결정 없음.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace`
