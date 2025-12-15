# Claude Code Slack Bot - System Overview

## Version
- Document Version: 1.0
- Last Updated: 2025-12-13

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
| Working Directory Manager | `working-directory-manager.ts` | 작업 디렉토리 설정 및 해석 |
| File Handler | `file-handler.ts` | 파일 업로드 처리 및 변환 |
| MCP Manager | `mcp-manager.ts` | MCP 서버 설정 및 관리 |
| Permission MCP Server | `permission-mcp-server.ts` | Slack 기반 권한 승인 |
| User Settings Store | `user-settings-store.ts` | 사용자 설정 영속화 |
| Todo Manager | `todo-manager.ts` | 태스크 목록 관리 |
| GitHub Auth | `github-auth.ts` | GitHub App 인증 |
| Credentials Manager | `credentials-manager.ts` | Claude 인증 관리 |
| MCP Call Tracker | `mcp-call-tracker.ts` | MCP 호출 추적 및 예측 |

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
| Claude SDK | @anthropic-ai/claude-code |
| MCP SDK | @modelcontextprotocol/sdk |
| Authentication | jsonwebtoken |
| Process Mode | Socket Mode |

## 7. File Structure

```
claude-code-slack-bot/
├── src/
│   ├── index.ts                    # Entry point
│   ├── config.ts                   # Configuration
│   ├── slack-handler.ts            # Slack event handling
│   ├── claude-handler.ts           # Claude SDK integration
│   ├── working-directory-manager.ts
│   ├── file-handler.ts
│   ├── image-handler.ts
│   ├── todo-manager.ts
│   ├── mcp-manager.ts
│   ├── permission-mcp-server.ts
│   ├── shared-store.ts
│   ├── user-settings-store.ts
│   ├── github-auth.ts
│   ├── git-cli-auth.ts
│   ├── credentials-manager.ts
│   ├── credential-alert.ts
│   ├── mcp-call-tracker.ts
│   ├── logger.ts
│   ├── stderr-logger.ts
│   ├── types.ts
│   ├── prompt/
│   │   └── system.prompt           # System prompt
│   └── persona/
│       ├── default.md
│       └── *.md                    # Custom personas
├── data/
│   ├── user-settings.json          # User preferences
│   ├── sessions.json               # Session persistence
│   ├── mcp-call-stats.json         # MCP call statistics
│   └── slack_jira_mapping.json     # Slack-Jira mapping
├── mcp-servers.json                # MCP server config
├── claude-code-settings.json       # Claude SDK permissions
└── logs/
    ├── stdout.log
    └── stderr.log
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
