# LlmRuntime Adapter Layer — Vertical Trace

> STV Trace | Created: 2026-04-03
> Spec: docs/llm-runtime-adapter/spec.md
> Issue: #332

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | LlmRuntime interface + types | small | Ready |
| 2 | CodexRuntime implementation | medium | Ready |
| 3 | GeminiRuntime implementation | medium | Ready |
| 4 | llm-mcp-server.ts router refactor | medium | Ready |
| 5 | Unit tests for runtimes | medium | Ready |
| 6 | Integration test for llm-mcp-server | small | Ready |

---

## Scenario 1: LlmRuntime interface + types

### Size: small (~20 lines)

### 1. Entry Point
**New file**: `mcp-servers/llm/runtime/types.ts`

### 2. Type Definitions

```typescript
// mcp-servers/llm/runtime/types.ts

export type Backend = 'codex' | 'gemini';

export interface SessionOptions {
  model: string;
  cwd?: string;
  config?: Record<string, unknown>;
}

export interface SessionResult {
  sessionId: string;
  content: string;
  backend: Backend;
  model: string;
}

export interface RuntimeCapabilities {
  supportsReview: boolean;
  supportsInterrupt: boolean;
  supportsResume: boolean;
  supportsEventStream: boolean;
}

export interface LlmRuntime {
  readonly name: Backend;
  readonly capabilities: RuntimeCapabilities;
  initialize(): Promise<void>;
  startSession(prompt: string, options: SessionOptions): Promise<SessionResult>;
  resumeSession(sessionId: string, prompt: string): Promise<SessionResult>;
  shutdown(): Promise<void>;
}
```

### 3. Parameter Flow
- `Backend` type moved from llm-mcp-server.ts → runtime/types.ts (re-exported)
- `BackendConfig` stays in llm-mcp-server.ts (routing config, not runtime concern)

---

## Scenario 2: CodexRuntime implementation

### Size: medium (~80 lines)

### 1. Entry Point
**New file**: `mcp-servers/llm/runtime/codex-runtime.ts`

### 2. Call Stack

```
CodexRuntime.initialize()
  → cliExists('codex')                           // from llm-mcp-server.ts L105-112
  → new McpClient({ command: 'codex', args: ['mcp-server'] })  // L130-131
  → client.start()                               // L135

CodexRuntime.startSession(prompt, options)
  → this.ensureClient()                          // lazy init if needed
  → client.callTool('codex', backendArgs, 600_000)  // L255-256
  → extractSessionId(result)                     // 'threadId' key, L149-162
  → store session locally
  → return SessionResult
  // (REMOVED in #639: expandConfigForCodex + per-call config merge; the
  //  llmChatConfigStore subsystem that fed `configOverride` was deleted.)

CodexRuntime.resumeSession(sessionId, prompt)
  → this.ensureClient()
  → client.callTool('codex-reply', { prompt, threadId: sessionId }, 600_000)  // L295-296
  → extract new sessionId if changed
  → return SessionResult

CodexRuntime.shutdown()
  → client?.stop()
```

### 3. Moved Logic
| From (llm-mcp-server.ts) | To (codex-runtime.ts) |
|---|---|
| L56-77: `expandConfigForCodex()` | private method |
| L105-112: `cliExists('codex')` | `initialize()` |
| L119-121, L130-131: client spawn | `initialize()` |
| L243-256: handleChat codex branch | `startSession()` |
| L288-296: handleChatReply codex branch | `resumeSession()` |
| L149-162: `extractBackendSessionId('codex', ...)` | private `extractSessionId()` |
| L258-267: response parsing + cleanup | private `parseResponse()` |

---

## Scenario 3: GeminiRuntime implementation

### Size: medium (~60 lines)

### 1. Entry Point
**New file**: `mcp-servers/llm/runtime/gemini-runtime.ts`

### 2. Call Stack

```
GeminiRuntime.initialize()
  → cliExists('gemini')                          // L122-124
  → new McpClient({ command: 'npx', args: ['@2lab.ai/gemini-mcp-server'] })  // L132
  → client.start()

GeminiRuntime.startSession(prompt, options)
  → this.ensureClient()
  → client.callTool('chat', { prompt, model: options.model }, 600_000)  // L255
  → extractSessionId(result)                     // 'sessionId' key
  → return SessionResult

GeminiRuntime.resumeSession(sessionId, prompt)
  → this.ensureClient()
  → client.callTool('chat-reply', { prompt, sessionId }, 600_000)  // L295
  → return SessionResult

GeminiRuntime.shutdown()
  → client?.stop()
```

### 3. Key Differences from CodexRuntime
| Aspect | Codex | Gemini |
|---|---|---|
| CLI check | `codex` | `gemini` |
| Spawn command | `codex mcp-server` | `npx @2lab.ai/gemini-mcp-server` |
| Start tool name | `codex` | `chat` |
| Reply tool name | `codex-reply` | `chat-reply` |
| Session ID key | `threadId` | `sessionId` |
| Config expansion | Yes (dot-notation) | No |

---

## Scenario 4: llm-mcp-server.ts router refactor

### Size: medium (~50 lines changed)

### 1. Before/After

**Before** (328 lines):
- Monolith with 5 backend-specific branches
- Direct McpClient management
- Inline response parsing

**After** (~120 lines):
- Pure router: route model → get runtime → delegate
- No backend-specific code
- Runtime lifecycle management only

### 2. Refactored Structure

```typescript
// llm-mcp-server.ts (after)

import { LlmRuntime, Backend, SessionResult } from './runtime/types.js';
import { CodexRuntime } from './runtime/codex-runtime.js';
import { GeminiRuntime } from './runtime/gemini-runtime.js';

// Config + routeModel() — unchanged

const runtimes: Record<Backend, LlmRuntime> = {
  codex: new CodexRuntime(),
  gemini: new GeminiRuntime(),
};

class LlmMCPServer extends BaseMcpServer {
  // defineTools() — unchanged

  async handleChat(args) {
    const route = routeModel(model);
    const runtime = runtimes[route.backend];
    await runtime.initialize();  // idempotent
    const result = await runtime.startSession(prompt, { model: route.model, cwd, config });
    return formatResult(result);
  }

  async handleChatReply(args) {
    const session = sessions.get(sessionId);  // still needed for backend lookup
    const runtime = runtimes[session.backend];
    const result = await runtime.resumeSession(session.backendSessionId, prompt);
    updateSession(sessionId, result);
    return formatResult(result);
  }

  async shutdown() {
    await Promise.all(Object.values(runtimes).map(r => r.shutdown()));
  }
}
```

### 3. Session Management
- `sessions` Map stays in llm-mcp-server.ts (public session ID → backend session ID mapping)
- Each runtime tracks its own internal state
- Router manages the mapping layer

---

## Scenario 5: Unit tests for runtimes

### Size: medium (~80 lines)

### Files
- `mcp-servers/llm/runtime/codex-runtime.test.ts`
- `mcp-servers/llm/runtime/gemini-runtime.test.ts`

### Test Cases

**CodexRuntime:**
1. `initialize()` — throws if codex CLI not found
2. `startSession()` — calls codex tool with correct args + config expansion
3. `startSession()` — extracts threadId from response
4. `resumeSession()` — calls codex-reply with threadId
5. `resumeSession()` — handles session ID change

**GeminiRuntime:**
1. `initialize()` — throws if gemini CLI not found
2. `startSession()` — calls chat tool with correct args (no config expansion)
3. `startSession()` — extracts sessionId from response
4. `resumeSession()` — calls chat-reply with sessionId

### Mock Strategy
- Mock `McpClient` — inject via constructor (DI)
- Mock `execFileSync` for CLI existence check

---

## Scenario 6: Integration test for llm-mcp-server

### Size: small (~30 lines)

### File
- `mcp-servers/llm/llm-mcp-server.test.ts`

### Test Cases
1. `routeModel('codex')` → returns codex config
2. `routeModel('gemini')` → returns gemini config
3. `routeModel('gpt-5.4')` → routes to codex
4. `routeModel('gemini-3.1-pro')` → routes to gemini
5. Tool definitions unchanged (chat, chat-reply only)

### Note
- Full E2E test (actual CLI spawn) is not feasible in CI — mock runtimes
