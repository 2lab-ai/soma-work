# LlmRuntime Adapter Layer — Spec

> Issue: #332 | Created: 2026-04-03

## Problem

`llm-mcp-server.ts`(328행)에 백엔드별 분기(`if codex / else gemini`)가 5곳에 산재.
새 백엔드 추가 시 5곳을 동시에 수정해야 하고, 후속 이슈(#333~#338)가 모두 이 구조에 의존.

## AS-IS

```
llm-mcp-server.ts (328 lines, monolith)
├── routeModel()           — model string → BackendConfig
├── getClient()            — if codex: spawn codex mcp / else: spawn gemini mcp
├── handleChat()           — if codex: codex tool / else: chat tool + codex config expansion
├── handleChatReply()      — if codex: codex-reply + threadId / else: chat-reply + sessionId
├── extractBackendSessionId() — if codex: threadId / else: sessionId
└── sessions Map<string, Session>  — in-memory, coupled to backend
```

분기 5곳:
1. `getClient()` L119-132: CLI 존재 확인 + spawn command
2. `handleChat()` L243-255: config expansion + tool name (`codex` vs `chat`)
3. `handleChatReply()` L288-295: session ID key + tool name (`codex-reply` vs `chat-reply`)
4. `extractBackendSessionId()` L149-162: `threadId` vs `sessionId`
5. `storeSession()` L164-169: session key 선택

## TO-BE

```
llm-mcp-server.ts (~120 lines, router only)
├── routeModel()           — unchanged
├── runtimes Map<Backend, LlmRuntime>
├── handleChat()           — runtime.startSession(prompt, options)
└── handleChatReply()      — runtime.resumeSession(sessionId, prompt)

LlmRuntime interface
├── CodexRuntime           — McpClient 경유, codex-specific 로직 캡슐화
└── GeminiRuntime          — McpClient 경유, gemini-specific 로직 캡슐화
```

## LlmRuntime Interface Design

```typescript
interface SessionOptions {
  model: string;
  cwd?: string;
  // NOTE: per-call `config` / `configOverride` fields were removed in PR #639
  // along with the llmChatConfigStore subsystem. Runtimes now pull their own
  // defaults from their own config module rather than accepting caller-
  // supplied overrides on every invocation.
}

interface SessionResult {
  /** Backend-native session ID (threadId for Codex, sessionId for Gemini) */
  backendSessionId: string;
  content: string;
  backend: Backend;
  model: string;
}

interface LlmRuntime {
  readonly name: Backend;

  /** Capability flags for future extension (#333-#338) */
  readonly capabilities: RuntimeCapabilities;

  /**
   * Ensure the runtime is ready. Idempotent — reuses live client, recreates dead one.
   * Replaces explicit initialize() to preserve current lazy/self-healing behavior.
   */
  ensureReady(): Promise<void>;

  /**
   * Start a new chat session.
   * Runtime does NOT store sessions — returns backendSessionId for router to track.
   */
  startSession(prompt: string, options: SessionOptions): Promise<SessionResult>;

  /**
   * Continue an existing session.
   * Takes backendSessionId (not public session ID — router owns that mapping).
   */
  resumeSession(backendSessionId: string, prompt: string): Promise<SessionResult>;

  /** Clean shutdown */
  shutdown(): Promise<void>;
}

interface RuntimeCapabilities {
  supportsReview: boolean;       // #337
  supportsInterrupt: boolean;    // #334
  supportsResume: boolean;       // always true
  supportsEventStream: boolean;  // #336
}
```

## File Structure

```
mcp-servers/llm/
├── llm-mcp-server.ts          — router only (~120 lines)
├── llm-mcp-server.test.ts     — integration tests
├── runtime/
│   ├── types.ts               — LlmRuntime, SessionOptions, SessionResult
│   ├── codex-runtime.ts       — CodexRuntime implements LlmRuntime
│   ├── codex-runtime.test.ts
│   ├── gemini-runtime.ts      — GeminiRuntime implements LlmRuntime
│   └── gemini-runtime.test.ts
```

## Constraints

- MCP 경유 방식 유지 (app-server 직접 통합은 #335)
- 새 MCP tool 추가 없음 (review/task는 #337)
- 세션 영속화 없음 (#333)
- `chat`/`chat-reply` 외부 인터페이스 변경 없음
- capabilities는 정의만 하고 현재는 모두 false (supportsResume만 true)

## Architecture Decision: capabilities를 인터페이스에 넣는 이유

후속 이슈 #333~#338이 각각 capability를 true로 켜면서 구현을 채운다.
라우터(`llm-mcp-server.ts`)는 capability 체크로 tool 노출을 제어할 수 있다.
예: `if (runtime.capabilities.supportsReview)` → review tool 노출.
