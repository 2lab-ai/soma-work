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
│   (~600 LOC)     │    │   (~610 LOC)     │    │   (~96 LOC)      │
└──────────────────┘    └──────────────────┘    └──────────────────┘
          │                       │                       │
          ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  src/slack/      │    │  Session +       │    │   src/mcp/       │
│  - EventRouter   │    │  Prompt Modules  │    │  - ConfigLoader  │
│  - CommandRouter │    │  - SessionReg    │    │  - ServerFactory │
│  - StreamProc    │    │  - PromptBuilder │    │  - InfoFormatter │
│  - ToolEventProc │    │  - DispatchSvc   │    │                  │
│  - Commands/*    │    │  - McpConfigBldr │    │                  │
│  - Actions/*     │    │                  │    │                  │
│  - Pipeline/*    │    ├──────────────────┤    │                  │
│  - Directives/*  │    │  src/conversation │    │                  │
│  - Formatters/*  │    │  src/model-cmds  │    │                  │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

## Core Components

### 1. Entry Point (`src/index.ts`)
앱 초기화 및 Slack Bolt 앱 설정

### 2. SlackHandler (Facade, ~600 LOC)
Slack 이벤트 처리의 진입점. 다음 컴포넌트에 위임:

| Component | 책임 |
|-----------|------|
| `EventRouter` (293) | 이벤트 라우팅 (DM, mention, thread) |
| `CommandRouter` (105) | 명령어 감지 및 핸들러 디스패치 (20개 핸들러) |
| `StreamProcessor` (837) | Claude SDK 스트림 처리 |
| `ToolEventProcessor` | tool_use/tool_result 처리 |
| `RequestCoordinator` | 세션별 동시성 제어 |
| `ToolTracker` | 도구 사용 추적 |
| `Actions/*` | 인터랙티브 액션 핸들러 (9개) |
| `Pipeline/*` | 스트림 처리 파이프라인 (input → session → stream) |
| `Directives/*` | 채널/세션 링크 디렉티브 |

### 3. ClaudeHandler (Facade, ~610 LOC)
Claude SDK 통합. 다음 컴포넌트에 위임:

| Component | 책임 |
|-----------|------|
| `SessionRegistry` (1,048) | 세션 생성/조회/영속성 |
| `PromptBuilder` (299) | 시스템 프롬프트 + 페르소나 조립 |
| `DispatchService` (509) | 워크플로우 분류 및 디스패치 (9개 워크플로우) |
| `McpConfigBuilder` (347) | MCP 설정 조립 |

### 4. McpManager (Facade)
MCP 서버 설정 관리. 다음 컴포넌트에 위임:

| Component | 책임 |
|-----------|------|
| `McpConfigLoader` | 설정 파일 로드/검증 |
| `McpServerFactory` | 서버 생성/GitHub 인증 주입 |
| `McpInfoFormatter` | 상태 정보 포맷팅 |

## Directory Structure

```
src/                              # ~27,000 LOC (excl. test/local)
├── index.ts                      # Entry point
├── config.ts                     # Environment configuration
├── slack-handler.ts              # Slack event facade (~600)
├── claude-handler.ts             # Claude SDK facade (~610)
├── mcp-manager.ts                # MCP configuration facade (~96)
├── dispatch-service.ts           # Workflow dispatch (509)
├── session-registry.ts           # Session management (1,048)
├── prompt-builder.ts             # Prompt construction (299)
├── mcp-config-builder.ts         # MCP config construction (347)
├── channel-registry.ts           # Channel management
├── channel-description-cache.ts  # Channel description cache
├── claude-usage.ts               # Token usage tracking
├── credential-alert.ts           # Credential warnings
├── link-metadata-fetcher.ts      # Link preview fetching
├── llm-mcp-server.ts             # LLM as MCP server
├── model-command-mcp-server.ts   # Model switching MCP
├── release-notifier.ts           # Release notifications
├── token-manager.ts              # CCT token pool management
├── todo-manager.ts               # Task tracking
├── admin-utils.ts                # Admin command utilities
├── credentials-manager.ts        # Credential management
├── dangerous-command-filter.ts   # Bypass danger filter
├── env-paths.ts                  # Environment path resolution
├── file-handler.ts               # File handling
├── github-auth.ts                # GitHub auth facade
├── mcp-call-tracker.ts           # MCP call statistics
├── mcp-client.ts                 # MCP client
├── permission-mcp-server.ts      # Permission MCP server (245)
├── stderr-logger.ts              # Stderr logging
├── unified-config-loader.ts      # Unified config loader
├── user-settings-store.ts        # User settings persistence
├── working-directory-manager.ts  # Working directory management
│
├── slack/                        # Slack-specific modules
│   ├── event-router.ts           # Event routing (293)
│   ├── stream-processor.ts       # SDK stream handling (837)
│   ├── commands/                 # 20 command handlers
│   │   ├── command-router.ts     # Command dispatching (105)
│   │   ├── cwd-handler.ts
│   │   ├── mcp-handler.ts
│   │   ├── bypass-handler.ts
│   │   ├── persona-handler.ts
│   │   ├── model-handler.ts
│   │   ├── session-handler.ts
│   │   ├── help-handler.ts
│   │   ├── restore-handler.ts
│   │   ├── close-handler.ts      # Session close
│   │   ├── context-handler.ts    # Context window status
│   │   ├── link-handler.ts       # Session link attach
│   │   ├── new-handler.ts        # Session reset
│   │   ├── renew-handler.ts      # Session renew
│   │   ├── onboarding-handler.ts # Onboarding workflow
│   │   ├── verbosity-handler.ts  # Verbosity settings
│   │   ├── session-command-handler.ts  # $ prefix commands
│   │   ├── admin-handler.ts      # Admin commands (accept/deny/users/config)
│   │   ├── cct-handler.ts        # CCT token management
│   │   ├── marketplace-handler.ts # Plugin marketplace
│   │   └── plugins-handler.ts    # Plugin management
│   ├── actions/                  # 9 interactive action handlers
│   │   ├── action-panel-action-handler.ts  # Thread action panel
│   │   ├── channel-route-action-handler.ts # Channel routing
│   │   ├── choice-action-handler.ts        # User choices
│   │   ├── form-action-handler.ts          # Form submissions
│   │   ├── jira-action-handler.ts          # Jira actions
│   │   ├── permission-action-handler.ts    # Permission approve/deny
│   │   ├── pr-action-handler.ts            # PR actions
│   │   ├── session-action-handler.ts       # Session actions
│   │   └── user-acceptance-action-handler.ts # User acceptance gate
│   ├── pipeline/                 # Stream processing pipeline
│   │   ├── input-processor.ts    # Input preprocessing (79)
│   │   ├── session-initializer.ts # Session init (771)
│   │   └── stream-executor.ts    # Stream execution (1,551)
│   ├── directives/               # Channel/session directives
│   │   ├── channel-message-directive.ts
│   │   └── session-link-directive.ts
│   └── formatters/               # Output formatters
│       ├── directory-formatter.ts
│       └── markdown-to-blocks.ts # Markdown → Block Kit converter
│
├── conversation/                 # Conversation recording & replay
│   ├── recorder.ts               # Recording engine
│   ├── storage.ts                # Conversation storage
│   ├── summarizer.ts             # Conversation summarizer
│   ├── viewer.ts                 # Conversation viewer
│   └── web-server.ts             # Replay web server
│
├── model-commands/               # Model command system
│   ├── catalog.ts                # Command catalog
│   ├── result-parser.ts          # Result parsing
│   └── validator.ts              # Command validation
│
├── mcp/                          # MCP server management
│   ├── config-loader.ts          # Config file loading
│   ├── server-factory.ts         # Server provisioning
│   └── info-formatter.ts         # Info formatting
│
├── github/                       # GitHub integration
│   ├── api-client.ts             # GitHub API client
│   ├── git-credentials-manager.ts # Git credentials
│   └── token-refresh-scheduler.ts # Token auto-renewal
│
├── permission/                   # Permission system
│   ├── service.ts                # Permission service
│   └── slack-messenger.ts        # Slack permission UI
│
├── plugin/                       # Plugin system
│   ├── config-parser.ts          # Plugin config parsing
│   ├── marketplace-fetcher.ts    # Marketplace data fetching
│   ├── plugin-cache.ts           # Plugin cache management
│   ├── plugin-manager.ts         # Plugin lifecycle management
│   └── types.ts                  # Plugin type definitions
│
├── prompt/                       # Prompt templates
│   └── workflows/                # 9 workflow prompts
│       ├── pr-review.prompt
│       ├── pr-fix-and-update.prompt
│       ├── pr-docs-confluence.prompt
│       ├── jira-planning.prompt
│       ├── jira-executive-summary.prompt
│       ├── jira-brainstorming.prompt
│       ├── jira-create-pr.prompt
│       ├── deploy.prompt
│       └── onboarding.prompt
│
├── persona/                      # 12 bot personas
│   ├── default.md, chaechae.md, linus.md, buddha.md
│   ├── davinci.md, einstein.md, elon.md, feynman.md
│   ├── jesus.md, newton.md, turing.md, vonneumann.md
│
└── local/                        # Claude Code SDK local plugins
    ├── agents/                   # Agent definitions
    ├── skills/                   # Skill implementations
    │   ├── github-pr/            # PR-related skills
    │   ├── decision-gate/        # Decision gate skill
    │   ├── UIAskUserQuestion/    # User choice skill
    │   └── release-notes/        # Release notes skill
    ├── hooks/                    # Git/build hooks
    ├── commands/                 # Local slash commands
    └── prompts/                  # Local prompts
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
| Action Handlers | `action-panel-action-handler.test.ts`, `choice-action-handler.test.ts`, etc. |
| Pipeline | `session-initializer.test.ts`, `stream-executor.test.ts` |
| Directives | `channel-message-directive.test.ts`, `session-link-directive.test.ts` |
| Commands | `context-handler.test.ts`, `onboarding-handler.test.ts`, `renew-handler.test.ts` |
| Conversation | `web-server.test.ts` |

총 43개 테스트 파일, ~11,100 LOC.
