<p align="center">
  <img src="assets/logo.png" alt="soma-work" width="120" />
</p>

<h1 align="center">soma-work</h1>

<p align="center">
  <strong>Slack용 AI 코딩 어시스턴트 — Claude Code SDK 기반</strong>
</p>

<p align="center">
  <a href="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml"><img src="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/2lab-ai/soma-work/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Claude_Code_SDK-0.2-7C3AED?logo=anthropic&logoColor=white" alt="Claude Code SDK" />
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

---

## soma-work란?

Slack 워크스페이스의 모든 대화를 AI 코딩 세션으로 전환하는 멀티테넌트 봇입니다. DM을 보내거나, 채널에서 멘션하거나, 스레드에서 대화하면 — 봇이 코드를 읽고, PR을 리뷰하고, Jira 이슈를 정리하고, 컨텍스트를 유지한 채 솔루션을 작성합니다.

```
You:   이 PR 리뷰해줘 https://github.com/org/repo/pull/42
Bot:   [diff 분석, 소스 코드 읽기, 라인별 리뷰 코멘트 작성]

You:   PTN-1234 이슈 요약해줘
Bot:   [Jira 이슈 조회, 관련 PR/코드 분석, 경영진 보고용 요약 생성]

You:   이 함수 성능 개선해줘 [파일 첨부]
Bot:   [업로드된 코드 분석, 병목 지점 식별, 최적화된 버전 제안]
```

---

## ✨ 주요 기능

### 🔀 워크플로우 자동 분류

사용자 입력을 분류하여 최적의 워크플로우로 자동 라우팅합니다 — 수동 선택 불필요.

| 워크플로우 | 트리거 | 동작 |
|-----------|--------|------|
| **PR Review** | GitHub PR URL | 코드 리뷰 + 인라인 코멘트 |
| **PR Fix & Update** | `수정해줘` + PR URL | 수정 구현 → 커밋 → 푸시 |
| **PR Docs** | `문서화` + PR URL | Confluence 문서 생성 |
| **Jira Planning** | Jira 이슈 + `계획` | 태스크 분해 & 작업 분할 |
| **Jira Summary** | Jira 이슈 + `요약` | 경영진 보고서 생성 |
| **Jira Brainstorming** | Jira 이슈 + `브레인스토밍` | 아이디어 발산 & 종합 |
| **Jira → PR** | Jira 이슈 + `PR 만들어줘` | 이슈에서 PR 자동 생성 |
| **Deploy** | 배포 관련 요청 | 배포 워크플로우 오케스트레이션 |
| **Onboarding** | 신규 유저 / `onboarding` | 인터랙티브 가이드 셋업 |
| **Default** | 기타 모든 입력 | 범용 코딩 어시스턴트 |

### 🎭 12명의 천재 페르소나

봇의 성격과 사고방식을 전환합니다. 각 페르소나는 문제 해결에 고유한 접근법을 제공합니다.

```
persona einstein    → 제1원리 물리학적 사고
persona linus       → 무자비한 코드 리뷰
persona feynman     → "간단히 설명 못하면 이해 못한 것"
persona vonneumann  → 수학적 정밀함
```

사용 가능: `default` · `chaechae` · `linus` · `buddha` · `davinci` · `einstein` · `elon` · `feynman` · `jesus` · `newton` · `turing` · `vonneumann`

### 🔌 MCP 도구 생태계

MCP 호환 서버(stdio/SSE/HTTP)를 연결하여 Claude의 능력을 무한히 확장합니다. 호출 통계와 예상 소요 시간을 내장 추적합니다.

### 🔐 인터랙티브 권한

Slack 네이티브 버튼/폼 UX로 권한 승인, 선택지, 세션 관리를 처리합니다. 신뢰된 사용자를 위한 바이패스 모드 지원.

### 📎 파일 분석

이미지(JPG/PNG/GIF/WebP), 텍스트, 코드 파일을 Slack에서 직접 업로드 가능. 파일당 50MB 제한.

### 🔑 GitHub 연동

GitHub App(권장) 또는 Personal Access Token 인증. 자동 토큰 갱신 지원.

---

## 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                    Slack Events                     │
│              (DM / Mention / Thread)                │
└──────────────────────┬──────────────────────────────┘
                       │
                ┌──────▼──────┐
                │ SlackHandler │  ← Facade
                └──────┬──────┘
                       │
          ┌────────────┼────────────────┐
          │            │                │
   ┌──────▼──────┐ ┌──▼───────┐ ┌─────▼──────┐
   │ EventRouter │ │ Command  │ │  Stream    │
   │             │ │ Router   │ │ Processor  │
   └──────┬──────┘ └──┬───────┘ └─────┬──────┘
          │            │                │
          │     ┌──────▼──────┐  ┌─────▼──────┐
          │     │ 26 Command  │  │  Pipeline  │
          │     │  Handlers   │  │ input →    │
          │     └─────────────┘  │ session →  │
          │                      │ stream     │
          │                      └─────┬──────┘
          │                            │
   ┌──────▼────────────────────────────▼──────┐
   │              ClaudeHandler               │
   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
   │  │ Session  │ │ Prompt   │ │ Dispatch │ │
   │  │ Registry │ │ Builder  │ │ Service  │ │
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

**Three Facades** — `SlackHandler`, `ClaudeHandler`, `McpManager`가 복잡한 서브시스템 위에 단순한 인터페이스를 제공합니다. 각 모듈은 단일 책임 원칙을 따릅니다.

---

## 명령어

| 명령어 | 설명 |
|--------|------|
| `cwd [path]` | 작업 디렉토리 확인 / 설정 |
| `mcp` · `mcp reload` | MCP 서버 목록 / 설정 리로드 |
| `bypass [on\|off]` | 권한 바이패스 토글 |
| `persona [name]` | 페르소나 전환 |
| `model [name]` | 모델 전환 (sonnet, opus, haiku) |
| `verbosity [level]` | 출력 상세도 설정 |
| `sessions` | 활성 세션 목록 |
| `new` · `renew` | 세션 초기화 / 갱신 |
| `close` | 현재 스레드 세션 종료 |
| `restore` | 세션 복원 |
| `context` | 컨텍스트 윈도우 상태 |
| `link [url]` | 이슈/PR/문서 링크 첨부 |
| `onboarding` | 온보딩 워크플로우 실행 |
| `admin` | 관리자 명령 (accept/deny/users/config) |
| `cct` · `set_cct` | CCT 토큰 상태 / 수동 전환 |
| `marketplace` | 플러그인 마켓플레이스 |
| `plugins` | 설치된 플러그인 관리 |
| `$model` · `$verbosity` | 세션 전용 설정 (비영속) |
| `help` | 도움말 |

---

## 빠른 시작

### 1. 클론 & 설치

```bash
git clone https://github.com/2lab-ai/soma-work.git
cd soma-work
npm install
```

### 2. Slack App 생성

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. [`slack-app-manifest.json`](./slack-app-manifest.json) 내용 붙여넣기
3. 앱 생성 후:
   - **OAuth & Permissions** → Bot User OAuth Token 복사 (`xoxb-...`)
   - **Basic Information** → `connections:write` 스코프로 App-Level Token 생성 (`xapp-...`)
   - **Basic Information** → Signing Secret 복사

### 3. 환경 설정

```bash
cp .env.example .env
```

```env
# 필수
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
BASE_DIRECTORY=/path/to/code/

# 선택
ANTHROPIC_API_KEY=...              # Claude Code 구독 없을 때만 필요
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA..."
GITHUB_INSTALLATION_ID=12345678
GITHUB_TOKEN=ghp_...               # GitHub App 미설정 시 폴백
CLAUDE_CODE_USE_BEDROCK=1          # AWS Bedrock 사용
CLAUDE_CODE_USE_VERTEX=1           # Google Vertex AI 사용
DEBUG=true
```

### 4. MCP 서버 설정 (선택)

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

### 5. 실행

```bash
npm run dev                        # 개발 (watch mode)
npm start                          # 개발 (tsx)
npm run build && npm run prod      # 프로덕션
```

---

## 배포

### Docker

```bash
docker-compose up -d
docker-compose logs -f
```

### macOS LaunchAgent

```bash
./service.sh install     # LaunchAgent 설치
./service.sh start       # 서비스 시작
./service.sh logs follow # 실시간 로그
```

서비스 식별자: `ai.2lab.soma-work` — 크래시 시 자동 재시작.

> ⚠️ **개발 중에는 `service.sh`를 사용하지 마세요.** 같은 Slack 토큰으로 여러 인스턴스가 실행되면 메시지 충돌이 발생합니다.

---

## GitHub 연동

### GitHub App (권장)

1. [GitHub Developer Settings](https://github.com/settings/apps)에서 App 생성
2. 필요 권한: **Contents** (RW), **Issues** (RW), **Pull Requests** (RW), **Metadata** (R)
3. Private Key 생성 및 다운로드
4. 대상 리포지토리에 App 설치, Installation ID 확인
5. `.env`에 `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` 설정

### Personal Access Token (폴백)

1. GitHub Settings → Developer Settings → Personal Access Tokens
2. 필요 스코프: `repo`, `read:org`
3. `.env`에 `GITHUB_TOKEN` 설정

GitHub App이 설정되어 있으면 우선 사용됩니다. 없으면 PAT으로 자동 폴백.

---

## 프로젝트 구조

```
src/                                # TypeScript 소스
├── slack/                          # Slack 통합 레이어
│   ├── actions/                    # 인터랙티브 액션 핸들러 (12)
│   ├── commands/                   # 명령어 핸들러 (26)
│   ├── pipeline/                   # 스트림 처리 파이프라인
│   ├── directives/                 # 채널/세션 링크 디렉티브
│   └── formatters/                 # 출력 포맷터
├── conversation/                   # 대화 기록 & 리플레이
├── model-commands/                 # 모델 커맨드 카탈로그 & 검증
├── mcp/                            # MCP 서버 관리
├── github/                         # GitHub App 인증 + Git CLI
├── permission/                     # 권한 서비스 + Slack UI
├── plugin/                         # 플러그인 시스템 (마켓플레이스, 캐시)
├── prompt/                         # 시스템 프롬프트
│   └── workflows/                  # 워크플로우 프롬프트 (9)
├── persona/                        # 봇 페르소나 (12)
└── local/                          # Claude Code SDK 확장
    ├── agents/                     # Agent 정의 (11)
    ├── skills/                     # Skill 구현
    ├── hooks/                      # Git/빌드 훅
    ├── commands/                   # 로컬 슬래시 커맨드
    └── prompts/                    # 로컬 프롬프트

docs/                               # 아키텍처 & 기능 스펙
scripts/                            # 유틸리티 스크립트
```

| 항목 | 파일 수 | 코드 라인 |
|------|--------:|----------:|
| 소스 (테스트/로컬 제외) | 167 | ~36,000 |
| 테스트 | 97 | ~22,400 |
| 페르소나 | 12 | ~4,700 |
| 워크플로우 프롬프트 | 9 | ~1,400 |

## 설계 원칙

1. **Facade Pattern** — 3개의 Facade로 복잡한 서브시스템 단순화
2. **Single Responsibility** — 모듈당 하나의 책임 (167개 모듈)
3. **Pipeline Architecture** — 입력 전처리 → 세션 초기화 → 스트림 실행
4. **Workflow Dispatch** — 입력 분류 → 전문 워크플로우 프롬프트 적용
5. **Append-Only Messages** — 메시지 편집 대신 새 메시지 (안정성)
6. **Session-Based Context** — 스레드별 세션 유지 + 자동 재개
7. **Dependency Injection** — 주입된 의존성으로 테스트 용이성 확보
8. **Hierarchical CWD** — Thread > Channel > User 작업 디렉토리 우선순위

---

## 테스트

```bash
npx vitest run          # 단일 실행
npx vitest              # 감시 모드
```

97개 테스트 파일(~22,400 LOC)이 핵심 경로를 커버합니다: 이벤트 라우팅, 스트림 처리, 명령어 파싱, 권한 검증, 도구 포맷팅, 세션 관리, 액션 핸들러, 파이프라인 처리, MCP 통합 등.

---

## 문제 해결

| 증상 | 확인 사항 |
|------|-----------|
| 봇이 응답하지 않음 | 로그 확인 (`DEBUG=true`), Slack 토큰 유효성, 채널 초대 여부 |
| 인증 오류 | API 키 확인, Socket Mode 활성화 여부, 토큰 만료 |
| 포맷 깨짐 | Markdown → Slack mrkdwn 변환 한계 케이스 |
| 세션 충돌 | 같은 Slack 토큰으로 다중 인스턴스 실행 여부 |

---

## 라이선스

[MIT](./LICENSE)
