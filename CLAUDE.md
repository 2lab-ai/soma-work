# Claude Code Slack Bot

Slack에서 Claude Code SDK를 통해 AI 코딩 어시스턴트를 제공하는 TypeScript 기반 봇.

## Architecture

### Core Components
| 파일 | 역할 |
|------|------|
| `src/index.ts` | 진입점 |
| `src/config.ts` | 환경 설정 |
| `src/slack-handler.ts` | Slack 이벤트 처리 |
| `src/claude-handler.ts` | Claude SDK 통합, 세션 관리 |
| `src/working-directory-manager.ts` | 작업 디렉토리 관리 |
| `src/file-handler.ts` | 파일 업로드 처리 |
| `src/image-handler.ts` | 이미지 변환/인코딩 |
| `src/todo-manager.ts` | 태스크 추적 |
| `src/mcp-manager.ts` | MCP 서버 관리 |
| `src/mcp-client.ts` | MCP JSON-RPC 클라이언트 |
| `src/mcp-call-tracker.ts` | MCP 호출 통계/예측 |
| `src/permission-mcp-server.ts` | Slack 권한 프롬프트 MCP |
| `src/shared-store.ts` | IPC용 파일 기반 스토어 |
| `src/github-auth.ts` | GitHub App 인증 |
| `src/git-cli-auth.ts` | Git CLI 인증 |
| `src/credentials-manager.ts` | Claude 자격증명 관리 |
| `src/credential-alert.ts` | 자격증명 만료 알림 |
| `src/user-settings-store.ts` | 사용자 설정 저장 |
| `src/logger.ts` | 로깅 유틸리티 |
| `src/stderr-logger.ts` | MCP용 stderr 로거 |
| `src/types.ts` | 타입 정의 |

### Prompt & Persona System
```
src/prompt/
├── system.prompt      # 시스템 프롬프트 (역할, 워크플로우 정의)
└── review_prompt.md   # PR 리뷰 가이드라인

src/persona/
├── default.md         # 기본 페르소나
└── chaechae.md        # 커스텀 페르소나
```

### Data Files
```
data/
├── user-settings.json      # 사용자별 설정 (cwd, bypass 등)
├── sessions.json           # 활성 세션 정보
├── mcp-call-stats.json     # MCP 호출 통계
└── slack_jira_mapping.json # Slack-Jira 사용자 매핑
```

## Key Features

### 1. Working Directory Management
- **계층 구조**: Thread > Channel > User default
- `cwd project-name` 또는 `cwd /absolute/path`로 설정
- `BASE_DIRECTORY` 환경변수로 상대경로 기준점 설정

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
```

### Optional
```env
ANTHROPIC_API_KEY=...           # Claude Code 구독 없을 때만 필요
BASE_DIRECTORY=/Users/.../Code/ # 상대경로 기준
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
| `cwd [path]` | 작업 디렉토리 설정 |
| `mcp` | MCP 서버 목록 |
| `mcp reload` | MCP 설정 리로드 |
| `bypass [on/off]` | 권한 프롬프트 우회 |
| `sessions` | 활성 세션 목록 |

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
├── prompt/             # 시스템 프롬프트
├── persona/            # 봇 페르소나
scripts/                # 유틸리티 스크립트
data/                   # 런타임 데이터 (auto-generated)
logs/                   # 로그 파일
mcp-servers.json        # MCP 서버 설정
claude-code-settings.json # SDK 권한 설정
slack-app-manifest.json # Slack 앱 매니페스트
```

### Key Design Decisions
1. **Append-Only Messages**: 메시지 편집 대신 새 메시지 추가
2. **Session-Based Context**: 대화별 세션 유지
3. **Hierarchical CWD**: Thread > Channel > User 우선순위
4. **Real-Time Feedback**: 상태 리액션 + 라이브 태스크 업데이트
