# Claude Code Slack Bot

Slack에서 Claude Code SDK를 통해 AI 코딩 어시스턴트를 제공하는 TypeScript 기반 봇.

## Architecture

### Facade Pattern
복잡한 서브시스템을 단순한 인터페이스로 제공:

| Facade | 역할 | 위임 대상 |
|--------|------|----------|
| `SlackHandler` | Slack 이벤트 처리 | `EventRouter`, `CommandRouter`, `StreamProcessor` 등 |
| `ClaudeHandler` | Claude SDK 통합 | `SessionRegistry`, `PromptBuilder`, `McpConfigBuilder` |
| `McpManager` | MCP 서버 관리 | `ConfigLoader`, `ServerFactory`, `InfoFormatter` |

### Core Components
| 파일 | 역할 |
|------|------|
| `src/index.ts` | 진입점 |
| `src/config.ts` | 환경 설정 |
| `src/slack-handler.ts` | Slack 이벤트 처리 (facade) |
| `src/claude-handler.ts` | Claude SDK 통합 (facade) |
| `src/session-registry.ts` | 세션 생명주기 관리 |
| `src/prompt-builder.ts` | 시스템 프롬프트 + 페르소나 조립 |
| `src/mcp-config-builder.ts` | MCP 설정 조립 |
| `src/working-directory-manager.ts` | 작업 디렉토리 관리 |
| `src/file-handler.ts` | 파일 업로드 처리 |
| `src/image-handler.ts` | 이미지 변환/인코딩 |
| `src/todo-manager.ts` | 태스크 추적 |
| `src/mcp-manager.ts` | MCP 서버 관리 (facade) |
| `src/mcp-client.ts` | MCP JSON-RPC 클라이언트 |
| `src/mcp-call-tracker.ts` | MCP 호출 통계/예측 |
| `src/permission-mcp-server.ts` | Slack 권한 프롬프트 MCP |
| `src/shared-store.ts` | IPC용 파일 기반 스토어 |
| `src/github-auth.ts` | GitHub App 인증 (facade) |
| `src/credentials-manager.ts` | Claude 자격증명 관리 |
| `src/user-settings-store.ts` | 사용자 설정 저장 |
| `src/logger.ts` | 로깅 유틸리티 |
| `src/types.ts` | 타입 정의 |

### Modular Directories

```
src/slack/                   # Slack 모듈 (SRP 분리)
├── event-router.ts          # 이벤트 라우팅 (DM, mention, thread)
├── stream-processor.ts      # Claude SDK 스트림 처리
├── tool-event-processor.ts  # tool_use/tool_result 처리
├── request-coordinator.ts   # 세션별 동시성 제어
├── tool-tracker.ts          # 도구 사용 추적
├── message-validator.ts     # 메시지 검증
├── status-reporter.ts       # 상태 메시지 관리
├── todo-display-manager.ts  # 태스크 UI 관리
├── command-parser.ts        # 명령어 파싱
├── tool-formatter.ts        # 도구 출력 포맷팅
├── user-choice-handler.ts   # 사용자 선택 UI
├── message-formatter.ts     # 메시지 포맷팅
├── slack-api-helper.ts      # Slack API 래퍼
├── reaction-manager.ts      # 리액션 상태 관리
├── mcp-status-tracker.ts    # MCP 상태 UI
├── session-manager.ts       # 세션 UI 관리
├── action-handlers.ts       # 버튼 액션 처리
├── formatters/              # 포맷터 모듈
│   └── directory-formatter.ts
└── commands/                # 명령어 핸들러
    ├── cwd-handler.ts
    ├── mcp-handler.ts
    ├── bypass-handler.ts
    ├── persona-handler.ts
    ├── model-handler.ts
    ├── session-handler.ts
    ├── help-handler.ts
    └── restore-handler.ts

src/mcp/                     # MCP 모듈
├── config-loader.ts         # 설정 파일 로드/검증
├── server-factory.ts        # 서버 생성/GitHub 인증 주입
└── info-formatter.ts        # 상태 정보 포맷팅

src/github/                  # GitHub 모듈
├── api-client.ts            # GitHub API 클라이언트
├── git-credentials-manager.ts # Git 자격증명 관리
└── token-refresh-scheduler.ts # 토큰 자동 갱신

src/permission/              # Permission 모듈
├── service.ts               # 권한 서비스
└── slack-messenger.ts       # Slack 권한 메시지
```

### Prompt & Persona System
```
src/prompt/
├── system.prompt      # 시스템 프롬프트 (역할, 워크플로우 정의)
└── review_prompt.md   # PR 리뷰 가이드라인

src/persona/
├── default.md         # 기본 페르소나
├── chaechae.md        # 커스텀 페르소나
└── linus.md           # Linus Torvalds 페르소나
```

### Data Files
```
data/
├── user-settings.json      # 사용자별 설정 (cwd, bypass, persona, model 등)
├── sessions.json           # 활성 세션 정보
├── mcp-call-stats.json     # MCP 호출 통계
└── slack_jira_mapping.json # Slack-Jira 사용자 매핑
```

## Key Features

### 1. Working Directory Management
- **고정 디렉토리**: 각 유저별 `{BASE_DIRECTORY}/{userId}/` 사용
- 유저가 직접 설정 불가 (보안 격리)
- `cwd` 명령으로 현재 디렉토리 확인
- 디렉토리 자동 생성

### 2. Session Management
- 세션 소유권 (발화자 식별)
- 스레드 내 멘션 없이 응답 지원
- `sessions` 명령으로 활성 세션 목록 확인

### 3. Real-Time Task Tracking
```
📋 Task List
🔄 In Progress: 🔴 Analyze auth system
⏳ Pending: 🟡 Implement OAuth, 🟢 Add error handling
Progress: 1/3 (33%)
```

### 4. MCP Integration
- stdio/SSE/HTTP 서버 지원
- `mcp` - 설정된 서버 목록
- `mcp reload` - 설정 리로드
- 호출 통계 및 예상 시간 추적

### 5. Permission System
- Slack 버튼으로 권한 승인/거부
- `bypass` / `bypass on` / `bypass off` - 권한 프롬프트 우회 설정

### 6. File Upload
- 이미지: JPG, PNG, GIF, WebP (분석용)
- 텍스트/코드: 프롬프트에 직접 임베딩
- 50MB 제한, 자동 정리

### 7. GitHub Integration
- GitHub App 인증 (권장) 또는 PAT 폴백
- 자동 토큰 갱신 (만료 5분 전)
- Git CLI 자동 인증

## Environment Variables

### Required
```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
BASE_DIRECTORY=/Users/.../Code/ # 유저별 디렉토리 기준 ({BASE_DIRECTORY}/{userId}/)
```

### Optional
```env
ANTHROPIC_API_KEY=...           # Claude Code 구독 없을 때만 필요
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA..."
GITHUB_INSTALLATION_ID=12345678
GITHUB_TOKEN=ghp_...            # PAT 폴백
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_CODE_USE_VERTEX=1
DEBUG=true
```

## Usage

### Commands
| 명령 | 설명 |
|------|------|
| `cwd` | 현재 작업 디렉토리 확인 |
| `mcp` | MCP 서버 목록 |
| `mcp reload` | MCP 설정 리로드 |
| `bypass [on/off]` | 권한 프롬프트 우회 |
| `persona [name]` | AI 페르소나 변경 (default, chaechae, linus 등) |
| `model [name]` | 사용 모델 변경 (sonnet, opus, haiku) |
| `sessions` | 활성 세션 목록 |
| `terminate [session]` | 세션 종료 |
| `restore [session]` | 세션 복원 |
| `help` | 명령어 도움말 |

### Jira Mapping (scripts)
```bash
npm run mapping:list   # 매핑 목록
npm run mapping:sync   # Jira에서 동기화
npm run mapping:add    # 수동 추가
```

## Deployment (macOS)

### Service Script
```bash
./service.sh status|start|stop|restart|install|uninstall
./service.sh logs stderr 100    # 로그 확인
./service.sh logs follow        # 실시간 로그
```

### Service Config
- Name: `com.dd.claude-slack-bot`
- Plist: `~/Library/LaunchAgents/com.dd.claude-slack-bot.plist`
- Auto-start, Auto-restart on crash

## Development

> **주의**: 개발 중에는 `service.sh`로 LaunchAgent 서비스를 실행하지 마세요.
> 같은 Slack 토큰으로 여러 인스턴스가 동시에 실행되면 메시지 중복 처리 및 충돌이 발생합니다.
> 개발 시에는 `npm start` 또는 `npm run dev`만 사용하세요.

```bash
npm install
npm run build    # TypeScript 컴파일
npm start        # tsx로 개발 실행
npm run dev      # watch 모드
npm run prod     # 프로덕션 (빌드 필요)
```

### Project Structure
```
src/                    # 소스 코드
├── slack/              # Slack 관련 모듈 (SRP 분리)
├── mcp/                # MCP 관련 모듈
├── github/             # GitHub 관련 모듈
├── permission/         # Permission 관련 모듈
├── prompt/             # 시스템 프롬프트
├── persona/            # 봇 페르소나
scripts/                # 유틸리티 스크립트
data/                   # 런타임 데이터 (auto-generated)
logs/                   # 로그 파일
docs/                   # 문서
├── spec/               # 상세 스펙 문서
├── architecture.md     # 아키텍처 개요
└── srp-refactoring-plan.md  # 리팩토링 계획
mcp-servers.json        # MCP 서버 설정
claude-code-settings.json # SDK 권한 설정
slack-app-manifest.json # Slack 앱 매니페스트
```

### Key Design Decisions
1. **Facade Pattern**: 복잡한 서브시스템을 단순한 인터페이스로 제공
2. **Single Responsibility Principle**: 각 모듈이 하나의 책임만 담당
3. **Append-Only Messages**: 메시지 편집 대신 새 메시지 추가
4. **Session-Based Context**: 대화별 세션 유지
5. **Hierarchical CWD**: Thread > Channel > User 우선순위
6. **Real-Time Feedback**: 상태 리액션 + 라이브 태스크 업데이트
7. **Dependency Injection**: 테스트 용이성을 위한 의존성 주입
