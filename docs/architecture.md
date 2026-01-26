# Architecture Overview

Claude Code Slack Bot의 아키텍처 문서입니다.

## Module Dependency Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Entry Point                                 │
│                               index.ts                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   SlackHandler   │    │  ClaudeHandler   │    │   McpManager     │
│   (Facade)       │    │   (Facade)       │    │   (Facade)       │
└──────────────────┘    └──────────────────┘    └──────────────────┘
          │                       │                       │
          ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  src/slack/      │    │  Session +       │    │   src/mcp/       │
│  - EventRouter   │    │  Prompt Modules  │    │  - ConfigLoader  │
│  - CommandRouter │    │                  │    │  - ServerFactory │
│  - StreamProc    │    │                  │    │  - InfoFormatter │
│  - ToolEventProc │    │                  │    │                  │
│  - Commands/*    │    │                  │    │                  │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

## Core Components

### 1. Entry Point (`src/index.ts`)
앱 초기화 및 Slack Bolt 앱 설정

### 2. SlackHandler (Facade)
Slack 이벤트 처리의 진입점. 다음 컴포넌트에 위임:

| Component | 책임 |
|-----------|------|
| `EventRouter` | 이벤트 라우팅 (DM, mention, thread) |
| `CommandRouter` | 명령어 감지 및 핸들러 디스패치 |
| `StreamProcessor` | Claude SDK 스트림 처리 |
| `ToolEventProcessor` | tool_use/tool_result 처리 |
| `RequestCoordinator` | 세션별 동시성 제어 |
| `ToolTracker` | 도구 사용 추적 |

### 3. ClaudeHandler (Facade)
Claude SDK 통합. 다음 컴포넌트에 위임:

| Component | 책임 |
|-----------|------|
| `SessionRegistry` | 세션 생성/조회/영속성 |
| `PromptBuilder` | 시스템 프롬프트 + 페르소나 조립 |
| `McpConfigBuilder` | MCP 설정 조립 |

### 4. McpManager (Facade)
MCP 서버 설정 관리. 다음 컴포넌트에 위임:

| Component | 책임 |
|-----------|------|
| `McpConfigLoader` | 설정 파일 로드/검증 |
| `McpServerFactory` | 서버 생성/GitHub 인증 주입 |
| `McpInfoFormatter` | 상태 정보 포맷팅 |

## Directory Structure

```
src/
├── index.ts                 # Entry point
├── config.ts                # Environment configuration
├── slack-handler.ts         # Slack event facade
├── claude-handler.ts        # Claude SDK facade
├── mcp-manager.ts           # MCP configuration facade
│
├── slack/                   # Slack-specific modules
│   ├── index.ts             # Barrel export
│   ├── event-router.ts      # Event routing
│   ├── command-router.ts    # Command dispatching
│   ├── stream-processor.ts  # SDK stream handling
│   ├── tool-event-processor.ts  # Tool events
│   ├── request-coordinator.ts   # Concurrency control
│   ├── tool-tracker.ts      # Tool use tracking
│   ├── command-parser.ts    # Command parsing
│   ├── tool-formatter.ts    # Tool output formatting
│   ├── user-choice-handler.ts   # User prompts
│   ├── message-formatter.ts # Message formatting
│   ├── slack-api-helper.ts  # Slack API wrapper
│   ├── reaction-manager.ts  # Reaction state
│   ├── mcp-status-display.ts    # MCP status UI
│   ├── session-ui-manager.ts    # Session UI
│   ├── action-handlers.ts   # Button actions
│   ├── commands/            # Individual command handlers
│   │   ├── types.ts
│   │   ├── cwd-handler.ts
│   │   ├── mcp-handler.ts
│   │   ├── bypass-handler.ts
│   │   ├── persona-handler.ts
│   │   ├── model-handler.ts
│   │   ├── session-handler.ts
│   │   ├── help-handler.ts
│   │   └── restore-handler.ts
│   └── __tests__/           # Unit tests
│
├── mcp/                     # MCP-specific modules
│   ├── index.ts             # Barrel export
│   ├── config-loader.ts     # Config file loading
│   ├── server-factory.ts    # Server provisioning
│   └── info-formatter.ts    # Info formatting
│
├── session-registry.ts      # Session management
├── prompt-builder.ts        # Prompt construction
├── mcp-config-builder.ts    # MCP config construction
│
├── prompt/                  # Prompt templates
│   └── system.prompt        # System prompt
├── persona/                 # Bot personas
│   ├── default.md
│   └── chaechae.md
│
└── [other utilities]
```

## Design Principles

### 1. Single Responsibility Principle (SRP)
각 클래스는 하나의 책임만 가짐:
- `McpConfigLoader`: 설정 파일 로드만 담당
- `McpServerFactory`: 서버 생성만 담당
- `McpInfoFormatter`: 포맷팅만 담당

### 2. Facade Pattern
복잡한 서브시스템을 단순한 인터페이스로 제공:
- `SlackHandler` → 다수의 Slack 모듈
- `ClaudeHandler` → 세션/프롬프트/MCP 모듈
- `McpManager` → 설정/팩토리/포매터 모듈

### 3. Dependency Injection
테스트 용이성을 위한 의존성 주입:
```typescript
class CommandRouter {
  constructor(deps: CommandDependencies) {
    this.handlers = this.initializeHandlers(deps);
  }
}
```

### 4. Event-Driven Architecture
스트림 처리에서 콜백 기반 이벤트 처리:
```typescript
const callbacks: StreamCallbacks = {
  onAssistantMessage: (text) => { ... },
  onToolUse: (event) => { ... },
  onToolResult: (event) => { ... },
};
```

## Data Flow

### Message Processing
```
Slack Event → EventRouter → CommandRouter/StreamProcessor
                                    ↓
                            ClaudeHandler.streamQuery()
                                    ↓
                            ToolEventProcessor
                                    ↓
                            StreamProcessor.process()
                                    ↓
                            Slack Message Updates
```

### Session Lifecycle
```
New Message → SessionRegistry.getOrCreateSession()
                    ↓
              PromptBuilder.buildSystemPrompt()
                    ↓
              McpConfigBuilder.buildMcpOptions()
                    ↓
              Claude SDK query()
                    ↓
              SessionRegistry.updateSession()
```

## Testing Strategy

### Unit Tests (`src/slack/__tests__/`)
- 각 모듈별 독립 테스트
- Mock 의존성으로 격리

### Integration Tests
- 핵심 플로우 테스트 (concurrency, permissions, MCP cleanup)

### Test Categories
| Category | Files |
|----------|-------|
| Command Parsing | `command-parser.test.ts` |
| Stream Processing | `stream-processor.test.ts` |
| Tool Events | `tool-event-processor.test.ts` |
| Concurrency | `concurrency.test.ts` |
| Permissions | `permission-validation.test.ts` |
| MCP Cleanup | `mcp-cleanup.test.ts` |
