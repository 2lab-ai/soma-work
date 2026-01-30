# Claude Code Slack Bot

> *"In the beginning was the Word, and the Word was Code."*

Slack 워크스페이스에 AI 코딩 지성을 소환하는 TypeScript 봇.
Claude Code SDK를 통해 대화형 코딩 어시스턴트를 제공하며, 12명의 천재 페르소나, 워크플로우 자동 분류, MCP 도구 생태계, 실시간 태스크 추적을 지원합니다.

[English README](./README.md)

---

## What It Does

DM을 보내거나, 채널에서 멘션하거나, 스레드에서 대화하세요.
봇은 맥락을 기억하고, 코드를 읽고, 파일을 분석하고, PR을 리뷰하고, Jira 이슈를 정리하고, Confluence에 문서를 작성합니다.

```
You:    이 PR 리뷰해줘 https://github.com/org/repo/pull/42
Bot:    [PR을 분석하고, 코드를 읽고, 리뷰 코멘트를 작성합니다]

You:    PTN-1234 이슈 요약해줘
Bot:    [Jira에서 이슈를 가져오고, 관련 PR/코드를 분석하고, 경영진 보고용 요약을 생성합니다]

You:    이 함수 성능 개선해줘 [파일 업로드]
Bot:    [파일을 분석하고, 병목 지점을 찾고, 최적화된 코드를 제안합니다]
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Slack Events                     │
│              (DM / Mention / Thread)                │
└──────────────────────┬──────────────────────────────┘
                       │
                ┌──────▼──────┐
                │ SlackHandler │ ← Facade
                │   (314 LOC)  │
                └──────┬──────┘
                       │
          ┌────────────┼────────────────┐
          │            │                │
   ┌──────▼──────┐ ┌──▼───────┐ ┌─────▼──────┐
   │ EventRouter │ │ Command  │ │  Stream    │
   │   (272)     │ │ Router   │ │ Processor  │
   │             │ │  (95)    │ │  (512)     │
   └──────┬──────┘ └──┬───────┘ └─────┬──────┘
          │            │                │
          │     ┌──────▼──────┐  ┌─────▼──────┐
          │     │ 14 Command  │  │  Pipeline  │
          │     │  Handlers   │  │ input →    │
          │     └─────────────┘  │ session →  │
          │                      │ stream     │
          │                      └─────┬──────┘
          │                            │
   ┌──────▼────────────────────────────▼──────┐
   │              ClaudeHandler               │
   │                (381 LOC)                 │
   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
   │  │ Session  │ │ Prompt   │ │ Dispatch │ │
   │  │ Registry │ │ Builder  │ │ Service  │ │
   │  │  (522)   │ │  (298)   │ │  (368)   │ │
   │  └──────────┘ └──────────┘ └──────────┘ │
   └──────────────────┬───────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
   │   MCP   │  │ GitHub  │  │ Permis- │
   │ Manager │  │  Auth   │  │  sion   │
   └─────────┘  └─────────┘  └─────────┘
```

**Facade Pattern**: 3개의 Facade(`SlackHandler`, `ClaudeHandler`, `McpManager`)가 복잡한 서브시스템을 단순한 인터페이스로 제공합니다.

## Features

### Workflow Dispatch
사용자의 입력을 분석해 최적의 워크플로우를 자동 선택합니다.

| 워크플로우 | 트리거 | 동작 |
|-----------|--------|------|
| PR Review | PR URL 포함 | 코드 리뷰 + 코멘트 |
| PR Fix & Update | "수정해줘" + PR | 코드 수정 + 커밋 + 푸시 |
| PR Docs | "문서화" + PR | Confluence 페이지 생성 |
| Jira Planning | Jira 이슈 + 계획 | 태스크 분해 + 계획 수립 |
| Jira Summary | Jira 이슈 + 요약 | 경영진 보고서 생성 |
| Jira Brainstorming | Jira + 브레인스토밍 | 아이디어 발산 + 정리 |
| Default | 기타 모든 입력 | 범용 코딩 어시스턴트 |

### 12 Personas
봇의 성격과 사고방식을 전환합니다. `persona einstein`으로 아인슈타인처럼, `persona linus`로 리누스 토르발즈처럼 대화합니다.

`default` `chaechae` `linus` `buddha` `davinci` `einstein` `elon` `feynman` `jesus` `newton` `turing` `vonneumann`

### Real-Time Task Tracking
Claude가 작업 중인 태스크를 실시간으로 추적하고 Slack에 표시합니다.

### MCP Integration
stdio/SSE/HTTP 프로토콜의 MCP 서버를 연결해 Claude의 도구를 무한히 확장합니다. 호출 통계와 예상 소요 시간을 추적합니다.

### Interactive Actions
Slack 버튼/폼으로 권한 승인, 선택지 제시, 세션 관리를 인터랙티브하게 처리합니다.

### File Analysis
이미지(JPG/PNG/GIF/WebP), 텍스트, 코드 파일을 업로드하면 내용을 분석하고 프롬프트에 반영합니다. 50MB 제한.

### GitHub Integration
GitHub App 인증(권장) 또는 PAT 폴백. 자동 토큰 갱신으로 끊김 없는 Git 작업을 지원합니다.

## Commands

| 명령 | 설명 |
|------|------|
| `cwd` | 현재 작업 디렉토리 확인 |
| `mcp` / `mcp reload` | MCP 서버 목록 / 리로드 |
| `bypass [on/off]` | 권한 프롬프트 우회 |
| `persona [name]` | 페르소나 변경 |
| `model [name]` | 모델 변경 (sonnet, opus, haiku) |
| `sessions` | 활성 세션 목록 |
| `new` | 새 세션 시작 |
| `renew [prompt]` | 세션 갱신 |
| `restore [session]` | 세션 복원 |
| `terminate [session]` | 세션 종료 |
| `context` | 컨텍스트 윈도우 상태 |
| `help` | 도움말 |

## Quick Start

### 1. Clone & Install

```bash
git clone <repo-url>
cd claude-code-slack-bot
npm install
```

### 2. Create Slack App

1. [api.slack.com/apps](https://api.slack.com/apps)에서 **Create New App** 클릭
2. **From an app manifest** 선택
3. `slack-app-manifest.json` (또는 `.yaml`) 내용 붙여넣기
4. 앱 생성 후:
   - **OAuth & Permissions** → Bot User OAuth Token 복사 (`xoxb-...`)
   - **Basic Information** → App-Level Token 생성 (`connections:write` 스코프, `xapp-...`)
   - **Basic Information** → Signing Secret 복사

### 3. Configure Environment

```bash
cp .env.example .env
```

```env
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
BASE_DIRECTORY=/path/to/code/   # 유저별 작업 디렉토리 기준

# Optional
ANTHROPIC_API_KEY=...           # Claude Code 구독 없을 때만 필요
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA..."
GITHUB_INSTALLATION_ID=12345678
GITHUB_TOKEN=ghp_...            # GitHub App 미설정 시 폴백
CLAUDE_CODE_USE_BEDROCK=1       # AWS Bedrock 사용
CLAUDE_CODE_USE_VERTEX=1        # Google Vertex AI 사용
DEBUG=true
```

### 4. Configure MCP Servers (Optional)

```bash
cp mcp-servers.example.json mcp-servers.json
```

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}
```

### 5. Run

```bash
npm run dev      # 개발 (watch mode)
npm start        # 개발 (tsx)
npm run build && npm run prod  # 프로덕션
```

## Deployment

### Docker

```bash
docker-compose up -d
docker-compose logs -f
```

### macOS LaunchAgent

```bash
./service.sh install     # 서비스 설치
./service.sh start       # 시작
./service.sh logs follow # 실시간 로그
```

서비스 이름: `com.dd.claude-slack-bot`. 크래시 시 자동 재시작.

> **주의**: 개발 중에는 `service.sh`를 사용하지 마세요. 같은 Slack 토큰으로 여러 인스턴스가 실행되면 메시지 충돌이 발생합니다.

## GitHub Integration

### GitHub App (Recommended)

1. [GitHub Developer Settings](https://github.com/settings/apps)에서 App 생성
2. Permissions: Contents(RW), Issues(RW), Pull Requests(RW), Metadata(R)
3. Private Key 생성 & 다운로드
4. 리포지토리에 App 설치, Installation ID 메모
5. `.env`에 `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` 설정

### Personal Access Token (Fallback)

1. GitHub Settings → Developer Settings → Personal Access Tokens
2. `repo`, `read:org` 스코프 선택
3. `.env`에 `GITHUB_TOKEN` 설정

GitHub App이 설정되어 있으면 우선 사용되고, 없으면 PAT으로 폴백합니다.

## Project Structure

```
src/                            # ~13,800 lines of TypeScript
├── slack/                      # Slack 모듈 (SRP 분리)
│   ├── actions/                # 인터랙티브 액션 핸들러 (7 files)
│   ├── pipeline/               # 스트림 처리 파이프라인 (5 files)
│   ├── commands/               # 명령어 핸들러 (14 files)
│   └── formatters/             # 포맷터
├── mcp/                        # MCP 서버 관리
├── github/                     # GitHub App 인증 + Git CLI
├── permission/                 # 권한 서비스 + Slack UI
├── prompt/                     # 시스템 프롬프트
│   └── workflows/              # 워크플로우 프롬프트 (7 workflows)
└── persona/                    # 봇 페르소나 (12 personas)

data/                           # 런타임 데이터 (auto-generated)
docs/                           # 아키텍처 + 스펙 문서 (12 specs)
scripts/                        # 유틸리티 스크립트
```

| 항목 | 수치 |
|------|------|
| 소스 (테스트/로컬 제외) | 85 files, ~13,800 LOC |
| 테스트 | 20 files, ~5,600 LOC |
| 페르소나 | 12 files, ~4,700 LOC |
| 프롬프트 | 12 files, ~1,900 LOC |

## Design Decisions

1. **Facade Pattern** - 복잡한 서브시스템을 3개의 Facade로 단순화
2. **Single Responsibility** - 파일당 하나의 책임 (85개 모듈)
3. **Pipeline Architecture** - 입력 전처리 → 세션 초기화 → 스트림 실행
4. **Workflow Dispatch** - 입력 분류 → 전문 워크플로우 프롬프트 적용
5. **Append-Only Messages** - 메시지 편집 대신 새 메시지 추가
6. **Session-Based Context** - 스레드별 세션 유지
7. **Dependency Injection** - 테스트 용이성 확보

## Testing

```bash
npx vitest          # 전체 테스트
npx vitest run      # 단일 실행
npx vitest --watch  # 감시 모드
```

20개 테스트 파일이 핵심 경로를 커버합니다: 이벤트 라우팅, 스트림 처리, 명령어 파싱, 권한 검증, 도구 포맷팅, 세션 관리 등.

## Troubleshooting

| 증상 | 확인 사항 |
|------|-----------|
| 봇이 응답하지 않음 | `DEBUG=true`로 로그 확인, Slack 토큰 유효성, 채널 초대 여부 |
| 인증 오류 | API 키 확인, Socket Mode 활성화 여부, 토큰 만료 |
| 메시지 포맷 깨짐 | Claude의 Markdown → Slack mrkdwn 변환 한계 (복잡한 포맷은 제한적) |
| 세션 충돌 | 같은 토큰으로 다중 인스턴스 실행 여부 확인 |

## License

MIT
