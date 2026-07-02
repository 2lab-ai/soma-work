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

## 문서

- 현재 아키텍처, 스펙, trace, archive, 문서 라우팅 규칙은 [docs map](./docs/README.md)에서 시작합니다.
- 장기 유지할 결정은 [ADR index](./docs/adr/README.md)에 정리합니다.
- 완료/아카이브된 작업은 [completed work ledger](./docs/archive/completed-work.md)에서 추적합니다.
- AI agent 친화적인 프로젝트 문서 정리 리서치는 [docs/research](./docs/misc/research/2026-05-18-ai-agent-docs-organization.md)에 있습니다.
- Slack Block Kit/API 제약은 [docs/misc/reference/slack-block-kit.md](./docs/misc/reference/slack-block-kit.md)에 유지합니다.

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

세션 핸드오프 전용 entrypoint(`z-plan-to-work`, `z-epic-update`)도 있습니다 (#695) — free-text 분류가 아니라 `CONTINUE_SESSION` 핸드오프로 진입합니다. Source of truth: [`somalib/model-commands/session-types.ts`](./somalib/model-commands/session-types.ts)의 `WorkflowType`, [`src/dispatch-service.ts`](./src/dispatch-service.ts)의 `VALID_WORKFLOWS`; 프롬프트 파일은 [`src/prompt/workflows/`](./src/prompt/workflows/).

### 🎭 천재 페르소나

봇의 성격과 사고방식을 전환합니다. 각 페르소나는 문제 해결에 고유한 접근법을 제공합니다.

```
/z persona set einstein    → 제1원리 물리학적 사고
/z persona set linus       → 무자비한 코드 리뷰
/z persona set feynman     → "간단히 설명 못하면 이해 못한 것"
/z persona set vonneumann  → 수학적 정밀함
```

사용 가능: `default` · `linus` · `buddha` · `davinci` · `einstein` · `elon` · `feynman` · `jesus` · `newton` · `turing` · `vonneumann` — source of truth: [`src/persona/`](./src/persona/)

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
┌───────────────────────────────────────────────────┐
│                    Slack Events                     │
│              (DM / Mention / Thread)                │
└──────────────────────┬────────────────────────────┘
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
          │     │  Command    │  │  Pipeline  │
          │     │  Handlers   │  │ input →    │
          │     └─────────────┘  │ session →  │
          │                      │ stream     │
          │                      └─────┬──────┘
          │                            │
   ┌──────▼──────────────────────────▼──────┐
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

**Key Facades** — `SlackHandler`, `ClaudeHandler`, `McpManager`, `AgentManager`가 복잡한 서브시스템 위에 단순한 인터페이스를 제공합니다. 각 모듈은 단일 책임 원칙을 따릅니다. 전체 컴포넌트 와이어링은 [architecture.md](./docs/misc/reference/architecture.md)를 참고하세요.

---

## 명령어

목적이 겹치지 않는 4개의 prefix family:

| Prefix | 범위 | 지속성 | 예시 |
|--------|------|--------|------|
| `/z <topic> …` | 기본 명령어 surface (필요 시 Block Kit UI) | 유저 전역 | `/z persona set linus` |
| `%<sub> …` | **현재 세션 전용** — 저장 없이 오버라이드 | 휘발성 (`new`/`renew` 시 초기화) | `%model opus` |
| `$<skill>` / `$<plugin>:<skill>` | **강제 스킬 발동** (`SKILL.md` 로드, RPG 배너 출력) | 메시지 단위 | `$z`, `$stv:new-task` |
| naked text | 화이트리스트 bare form 또는 채팅 / 워크플로우 디스패치 | n/a | `sessions`, `new`, `fix PR 123` |

주요 `/z` 명령: `help` · `cwd` · `mcp` · `bypass` · `persona` · `model` · `verbosity` · `session` · `new`/`renew` · `close` · `restore` · `context`/`compact` · `link` · `onboarding` · `admin` · `cct` · `marketplace` · `plugin` · `skill` · `report`

- 전체 명령어 표와 마이그레이션 히스토리(#506, #508)는 [README.md의 Commands 섹션](./README.md#commands)을 참고하세요.
- naked 화이트리스트의 source of truth: [`src/slack/z/whitelist.ts`](./src/slack/z/whitelist.ts)
- `$model` 등 legacy `$` 세션 설정은 deprecation grace period 동안만 허용 (경고 후 `%` 사용 안내)

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
2. [`infra/slack/slack-app-manifest.json`](./infra/slack/slack-app-manifest.json) 내용 붙여넣기
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

`config.json`의 `mcpServers` 섹션을 수정:

```bash
cp config.example.json config.json
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
docker compose -f infra/docker/docker-compose.yml up -d
docker compose -f infra/docker/docker-compose.yml logs -f
```

### macOS LaunchAgent

```bash
./scripts/service.sh install     # LaunchAgent 설치
./scripts/service.sh start       # 서비스 시작
./scripts/service.sh logs follow # 실시간 로그
```

서비스 식별자: `ai.2lab.soma-work` — 크래시 시 자동 재시작.

> ⚠️ **개발 중에는 `scripts/service.sh`를 사용하지 마세요.** 같은 Slack 토큰으로 여러 인스턴스가 실행되면 메시지 충돌이 발생합니다.

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

> 숫자 카운트는 반드시 drift합니다 — 디렉토리를 직접 확인하세요. 전체 컴포넌트 와이어링: [docs/misc/reference/architecture.md](./docs/misc/reference/architecture.md)

```
src/                                # TypeScript 소스
├── agent-manager.ts                # 서브 에이전트 라이프사이클 관리
├── agent-instance.ts               # 개별 에이전트 (Slack App + Handler)
├── agent-runtime/                  # Claude Agent SDK 실행 런타임
├── slack/                          # Slack 통합 레이어
│   ├── actions/                    # 인터랙티브 액션 핸들러
│   ├── commands/                   # 명령어 핸들러
│   ├── pipeline/                   # 스트림 처리 파이프라인
│   ├── directives/                 # 채널/세션 링크 디렉티브
│   ├── formatters/                 # 출력 포맷터
│   └── z/                          # /z 명령어 surface + naked 화이트리스트
├── auth/                           # CCT lease + query env 주입
├── conversation/                   # 대화 기록 & 리플레이
├── model-commands/                 # 모델 커맨드 카탈로그 & 검증
├── mcp/                            # MCP 서버 관리
├── github/                         # GitHub App 인증 + Git CLI
├── permission/                     # 권한 서비스 + Slack UI
├── plugin/                         # 플러그인 시스템 (마켓플레이스, 캐시)
├── prompt/                         # 시스템 프롬프트 + workflows/
├── persona/                        # 봇 페르소나
├── sandbox/                        # 실행 샌드박스 게이트
├── metrics/                        # 토큰/비용 텔레메트리
├── notification-channels/          # Slack · DM · Telegram · Webhook 라우팅
└── local/                          # Claude Code SDK 확장 (skills/, agents/, hooks/)

packages/                           # 워크스페이스 패키지
├── mcp-servers/                    # 내장 MCP 서버 (agent, cron, llm, model-command, ...)
├── common/ · slack/ · process-shared/ · test-utils/

somalib/                            # soma 계열 공유 라이브러리
services/a2t/                       # 음성→텍스트 Python worker
infra/                              # docker / slack manifest / claude 설정
scripts/                            # 유틸리티 스크립트

docs/                               # 아키텍처 & 기능 스펙 — docs/README.md에서 시작
```

## 설계 원칙

1. **Facade Pattern** — 4개의 Facade(`SlackHandler`, `ClaudeHandler`, `McpManager`, `AgentManager`)로 복잡한 서브시스템 단순화
2. **Single Responsibility** — 모듈당 하나의 책임
3. **Pipeline Architecture** — 입력 전처리 → 세션 초기화 → 스트림 실행
4. **Workflow Dispatch** — 입력 분류 → 전문 워크플로우 프롬프트 적용
5. **Append-Only Messages** — 메시지 편집 대신 새 메시지 (안정성)
6. **Session-Based Context** — 스레드별 세션 유지 + 자동 재개
7. **Error Isolation** — 서브 에이전트 장애가 메인 봇으로 전파되지 않음
8. **Dependency Injection** — 주입된 의존성으로 테스트 용이성 확보
9. **Hierarchical CWD** — Thread > Channel > User 작업 디렉토리 우선순위

---

## 테스트

```bash
npx vitest run          # 단일 실행
npx vitest              # 감시 모드
```

테스트 커버리지: 이벤트 라우팅, 스트림 처리, 명령어 파싱, 권한 검증, 도구 포맷팅, 세션 관리, 액션 핸들러, 파이프라인 처리, MCP 통합, 멀티 에이전트 라이프사이클 등.

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
