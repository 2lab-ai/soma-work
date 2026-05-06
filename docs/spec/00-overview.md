# Claude Code Slack Bot - System Overview

## Version
- Document Version: 1.2
- Last Updated: 2026-02-25

## 1. System Description

Claude Code Slack Bot은 Slack 워크스페이스 내에서 Claude Code SDK를 통해 AI 기반 코딩 지원을 제공하는 TypeScript 기반 봇입니다. 사용자는 DM 또는 채널에서 봇과 대화하며, 실시간 코딩 지원, 파일 분석, 코드 리뷰, 프로젝트 관리 등의 기능을 사용할 수 있습니다.

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Slack Workspace                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │   DM     │  │ Channel  │  │  Thread  │  │  Files   │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
└───────┼─────────────┼──────────────┼─────────────┼──────────────────┘
        │             │              │             │
        └─────────────┴──────────────┴─────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Slack Handler   │
                    │ (Event Routing)   │
                    └─────────┬─────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼───────┐   ┌─────────▼─────────┐   ┌───────▼───────┐
│   Command     │   │   File Handler    │   │    Session    │
│   Parser      │   │   (Upload/DL)     │   │   Manager     │
└───────────────┘   └───────────────────┘   └───────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Claude Handler   │
                    │  (SDK Integration)│
                    └─────────┬─────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼───────┐   ┌─────────▼─────────┐   ┌───────▼───────┐
│  MCP Manager  │   │   Permission      │   │   Working     │
│  (External    │   │   System          │   │   Directory   │
│   Tools)      │   │                   │   │   Manager     │
└───────────────┘   └───────────────────┘   └───────────────┘
```

## 3. Core Components

### 3.1 Entry Point (`index.ts`)
- 애플리케이션 초기화 및 시작
- Slack App 인스턴스 생성
- MCP Manager 초기화
- GitHub App 인증 설정
- Graceful shutdown 처리

### 3.2 Slack Handler (`slack-handler.ts`)
- Slack 이벤트 수신 및 라우팅
- 메시지 처리 및 응답
- 명령어 파싱 및 실행
- 파일 업로드 처리
- Permission 버튼 핸들링

### 3.3 Claude Handler (`claude-handler.ts`)
- Claude Code SDK 연동
- 세션 생명주기 관리
- 스트리밍 응답 처리
- MCP 서버 설정 주입
- Persona 시스템 적용

### 3.4 Supporting Components
| Component | File | Description |
|-----------|------|-------------|
| Session Registry | `session-registry.ts` (1,048) | 세션 생명주기 관리 |
| Prompt Builder | `prompt-builder.ts` (299) | 시스템 프롬프트 + 페르소나 조립 |
| Dispatch Service | `dispatch-service.ts` (509) | 워크플로우 분류 및 디스패치 |
| MCP Config Builder | `mcp-config-builder.ts` (347) | MCP 설정 조립 |
| Working Directory Manager | `working-directory-manager.ts` | 작업 디렉토리 설정 및 해석 |
| File Handler | `file-handler.ts` | 파일 업로드 처리 및 변환 |
| MCP Manager | `mcp-manager.ts` | MCP 서버 설정 및 관리 |
| Permission MCP Server | `permission-mcp-server.ts` | Slack 기반 권한 승인 |
| User Settings Store | `user-settings-store.ts` | 사용자 설정 영속화 |
| Todo Manager | `todo-manager.ts` | 태스크 목록 관리 |
| GitHub Auth | `github-auth.ts` | GitHub App 인증 (facade) |
| Credentials Manager | `credentials-manager.ts` | Claude 인증 관리 |
| MCP Call Tracker | `mcp-call-tracker.ts` | MCP 호출 추적 및 예측 |
| Channel Registry | `channel-registry.ts` | 채널 관리 및 라우팅 |
| Claude Usage | `claude-usage.ts` | 토큰 사용량 추적 |
| Credential Alert | `credential-alert.ts` | 자격증명 경고 |
| Link Metadata Fetcher | `link-metadata-fetcher.ts` | 링크 프리뷰 메타데이터 |
| LLM MCP Server | `llm-mcp-server.ts` | LLM을 MCP 서버로 노출 |
| Model Command MCP Server | `model-command-mcp-server.ts` | 모델 전환 MCP |
| Release Notifier | `release-notifier.ts` | 릴리스 알림 |

### 3.5 Modular Subdirectories

**src/slack/** - Slack 이벤트 처리 모듈
| Component | Description |
|-----------|-------------|
| EventRouter (293) | 이벤트 라우팅 (DM, mention, thread) |
| StreamProcessor (837) | Claude SDK 스트림 처리 |
| ToolEventProcessor | tool_use/tool_result 처리 |
| RequestCoordinator | 세션별 동시성 제어 |
| commands/* (16개) | 개별 명령어 핸들러 |
| actions/* (8개) | 인터랙티브 액션 핸들러 (action-panel, choice, form, permission 등) |
| pipeline/* | 스트림 처리 파이프라인 (input → session → stream) |
| directives/* | 채널 메시지/세션 링크 디렉티브 |
| formatters/* | 출력 포맷터 |

**src/conversation/** - 대화 기록 모듈
| Component | Description |
|-----------|-------------|
| Recorder | 대화 기록 엔진 |
| Storage | 대화 저장소 |
| Summarizer | 대화 요약기 |
| Viewer | 대화 뷰어 |
| WebServer | 대화 리플레이 웹 서버 |

**src/model-commands/** - 모델 커맨드 모듈
| Component | Description |
|-----------|-------------|
| Catalog | 커맨드 카탈로그 |
| ResultParser | 결과 파싱 |
| Validator | 커맨드 검증 |

**src/mcp/** - MCP 서버 관리 모듈
| Component | Description |
|-----------|-------------|
| ConfigLoader | 설정 파일 로드/검증 |
| ServerFactory | 서버 생성/GitHub 인증 주입 |
| InfoFormatter | 상태 정보 포맷팅 |

**src/github/** - GitHub 통합 모듈
| Component | Description |
|-----------|-------------|
| ApiClient | GitHub API 클라이언트 |
| GitCredentialsManager | Git 자격증명 관리 |
| TokenRefreshScheduler | 토큰 자동 갱신 |

**src/permission/** - Permission 모듈
| Component | Description |
|-----------|-------------|
| PermissionService | 권한 요청/응답 관리 |
| SlackMessenger | Slack 권한 메시지 |

**src/local/** - Claude Code SDK 로컬 플러그인
| Component | Description |
|-----------|-------------|
| agents/ | Agent 정의 |
| skills/ | Skill 구현 (github-pr, decision-gate, UIAskUserQuestion, release-notes) |
| hooks/ | Git/빌드 훅 |
| commands/ | 로컬 슬래시 커맨드 |
| prompts/ | 로컬 프롬프트 |

## 4. Key Features

### 4.1 Communication
- **Direct Messages**: 1:1 대화 지원
- **Channel Mentions**: @멘션으로 채널에서 사용
- **Thread Context**: 스레드 내 컨텍스트 유지
- **File Uploads**: 다양한 파일 형식 분석

### 4.2 Working Directory
- **Base Directory**: 상대 경로 해석용 기본 디렉토리
- **Channel Defaults**: 채널별 기본 디렉토리
- **Thread Overrides**: 스레드별 개별 설정
- **User Defaults**: 사용자별 기본 디렉토리 (영속)

### 4.3 Session Management
- **Shared Sessions**: 채널/스레드 기반 공유 세션
- **Owner System**: 세션 소유자 및 현재 발화자 추적
- **Auto-expiry**: 24시간 비활성시 자동 만료
- **Persistence**: 재시작 시 세션 복원

### 4.4 MCP Integration
- **External Tools**: 외부 MCP 서버 연동
- **GitHub Integration**: GitHub API 접근
- **Jira Integration**: Atlassian Jira/Confluence 연동
- **Custom Servers**: 사용자 정의 MCP 서버 지원

### 4.5 Permission System
- **Interactive Prompts**: Slack 버튼으로 권한 승인
- **User Bypass**: 사용자별 권한 우회 설정
- **Timeout Handling**: 5분 타임아웃 자동 거부

### 4.6 Persona System
- **Custom Personas**: 사용자별 AI 페르소나 설정
- **File-based**: `.md` 파일로 페르소나 정의
- **Runtime Switch**: 실시간 페르소나 변경

## 5. Data Flow

### 5.1 Message Processing Flow
```
1. User Message → Slack Event
2. SlackHandler.handleMessage()
3. Command Detection (cwd, mcp, bypass, etc.)
4. Working Directory Resolution
5. Session Lookup/Creation
6. ClaudeHandler.streamQuery()
7. Response Streaming to Slack
8. Session Update
```

### 5.2 File Upload Flow
```
1. File Upload → Slack Event
2. FileHandler.downloadAndProcessFiles()
3. Content Extraction/Embedding
4. Prompt Augmentation
5. Claude Processing
6. Temp File Cleanup
```

### 5.3 Permission Flow
```
1. Claude Tool Request
2. Permission MCP Server → Slack Buttons
3. User Click (Approve/Deny)
4. SharedStore → File-based IPC
5. Permission Response → Claude
6. Tool Execution (if approved)
```

## 6. Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 18+ |
| Language | TypeScript |
| Slack SDK | @slack/bolt |
| Claude SDK | @anthropic-ai/claude-agent-sdk |
| MCP SDK | @modelcontextprotocol/sdk |
| Authentication | jsonwebtoken |
| Process Mode | Socket Mode |

## 7. File Structure

```
soma-work/
├── src/                              # ~27,000 LOC (122 source files)
│   ├── index.ts                      # Entry point
│   ├── config.ts                     # Configuration
│   ├── slack-handler.ts              # Slack event facade (567)
│   ├── claude-handler.ts             # Claude SDK facade (498)
│   ├── mcp-manager.ts               # MCP facade (76)
│   ├── dispatch-service.ts           # Workflow dispatch (509)
│   ├── session-registry.ts           # Session lifecycle (1,048)
│   ├── prompt-builder.ts             # Prompt assembly (299)
│   ├── mcp-config-builder.ts         # MCP config (347)
│   ├── channel-registry.ts           # Channel management
│   ├── claude-usage.ts               # Token usage tracking
│   ├── link-metadata-fetcher.ts      # Link preview
│   ├── llm-mcp-server.ts            # LLM as MCP server
│   ├── model-command-mcp-server.ts   # Model switching MCP
│   ├── release-notifier.ts           # Release notifications
│   ├── [other utilities]
│   │
│   ├── slack/                        # Slack modules (SRP)
│   │   ├── event-router.ts (293)
│   │   ├── stream-processor.ts (837)
│   │   ├── commands/                 # 16 command handlers
│   │   │   ├── command-router.ts, cwd-handler.ts, mcp-handler.ts
│   │   │   ├── bypass-handler.ts, persona-handler.ts, model-handler.ts
│   │   │   ├── session-handler.ts, help-handler.ts, restore-handler.ts
│   │   │   ├── close-handler.ts, context-handler.ts, link-handler.ts
│   │   │   ├── new-handler.ts, renew-handler.ts, onboarding-handler.ts
│   │   │   ├── verbosity-handler.ts, session-command-handler.ts
│   │   │   └── types.ts, index.ts
│   │   ├── actions/                  # 8 action handlers
│   │   │   ├── action-panel-action-handler.ts
│   │   │   ├── channel-route-action-handler.ts
│   │   │   ├── choice-action-handler.ts, form-action-handler.ts
│   │   │   ├── jira-action-handler.ts, permission-action-handler.ts
│   │   │   ├── pr-action-handler.ts, session-action-handler.ts
│   │   │   └── pending-form-store.ts, types.ts, index.ts
│   │   ├── pipeline/                 # Stream pipeline
│   │   │   ├── input-processor.ts (79)
│   │   │   ├── session-initializer.ts (771)
│   │   │   └── stream-executor.ts (1,551)
│   │   ├── directives/              # Channel/session directives
│   │   └── formatters/              # Output formatters
│   │
│   ├── conversation/                 # Conversation recording
│   │   ├── recorder.ts, storage.ts, summarizer.ts
│   │   ├── viewer.ts, web-server.ts
│   │   └── types.ts
│   │
│   ├── model-commands/               # Model command system
│   │   ├── catalog.ts, result-parser.ts, validator.ts
│   │   └── types.ts
│   │
│   ├── mcp/                          # MCP modules
│   │   ├── config-loader.ts, server-factory.ts, info-formatter.ts
│   │
│   ├── github/                       # GitHub modules
│   │   ├── api-client.ts, git-credentials-manager.ts
│   │   └── token-refresh-scheduler.ts
│   │
│   ├── permission/                   # Permission modules
│   │   ├── service.ts
│   │
│   ├── prompt/workflows/             # 9 workflow prompts
│   ├── persona/                      # 12 bot personas
│   │
│   └── local/                        # Claude Code SDK local plugins
│       ├── agents/, skills/, hooks/, commands/, prompts/
│
├── data/                             # Runtime data (auto-generated)
│   ├── user-settings.json, sessions.json
│   ├── mcp-call-stats.json, slack_jira_mapping.json
│   └── pending-forms.json
├── docs/
│   ├── spec/                         # 14 specification documents
│   ├── architecture.md               # Architecture overview
│   ├── slack-block-kit.md            # Slack Block Kit reference
│   └── verbosity-matrix.md           # Verbosity flag matrix
├── config.json                  # MCP server config
└── claude-code-settings.json         # Claude SDK permissions
```

## 8. Related Specifications

- [01-slack-integration.md](./01-slack-integration.md) - Slack 통합 스펙
- [02-claude-integration.md](./02-claude-integration.md) - Claude Code SDK 통합
- [03-session-management.md](./03-session-management.md) - 세션 관리
- [04-working-directory.md](./04-working-directory.md) - 작업 디렉토리 관리
- [05-file-handling.md](./05-file-handling.md) - 파일 처리
- [06-mcp-integration.md](./06-mcp-integration.md) - MCP 통합
- [07-permission-system.md](./07-permission-system.md) - 권한 시스템
- [08-user-settings.md](./08-user-settings.md) - 사용자 설정
- [09-configuration.md](./09-configuration.md) - 환경 설정
- [10-commands.md](./10-commands.md) - 명령어 레퍼런스
- [11-dispatch-refactor.md](./11-dispatch-refactor.md) - 워크플로우 디스패치 리팩터
- [12-ui-ask-user-question.md](./12-ui-ask-user-question.md) - UIAskUserQuestion 스펙
- [13-slack-ui-action-panel.md](./13-slack-ui-action-panel.md) - Slack 액션 패널 스펙
