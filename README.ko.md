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

You:   PROJ-1234 이슈 요약해줘
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

### 🤖 서브 에이전트 (부분 구현 · 프로비저닝 미지원)

서브 에이전트는 같은 프로세스 안에서 각자의 Slack App·Socket Mode 연결·세션 레지스트리를 갖는다.
다만 **추가 서브 에이전트를 만드는 지원 경로는 오늘 존재하지 않는다.** `somawork setup`은 프로파일의
주 Slack App 하나만 만들고, 옛 스크립트 두 개는 대체재가 아니다: `scripts/provision-agent.ts`는
아무것도 프로비저닝하지 않는 deprecation 래퍼이고(configuration token 저장·OAuth 콜백 수집·수동
app-token 프롬프트는 금지된 자격증명 경로라 삭제됨), `scripts/create-agent.sh`는 아직 돌지만
터미널에서 토큰을 받아 평문 config에 쓴다 — **자격증명을 발급·복사·저장하는 용도로 실행하지 마라.**
둘 다 패키징된 런타임에 들어가지 않는다.

상태·아키텍처 노트: [docs/misc/guides/how-to-new-agent.md](./docs/misc/guides/how-to-new-agent.md)
(설치 안내서가 아니다). 스키마의 정본은 `src/types.ts`의 `AgentConfig`.

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

주요 `/z` 명령: `help` · `cwd` · `mcp` · `bypass` · `persona` · `model` · `verbosity` · `session` · `new`/`renew` · `close` · `restore` · `context`/`compact` · `link` · `onboarding` · `admin` · `cct` · `auth` · `marketplace` · `plugin` · `skill` · `report`

- naked `cron`/`schedule`(크론/스케줄): 잡별 모델/출력 대상 드롭다운 + 삭제 버튼이 달린 인터랙티브 카드로 목록·수정. 텍스트 명령도 지원 — `cron model <name> <default|fast|모델>` (default = 만든 사람의 현재 모델) · `cron target <name> <channel|dm|thread>` · `cron delete <name>`; admin은 전체 유저 잡을 owner와 함께 보고 `<@owner>` 후행 인자 또는 카드에서 직접 타인 잡을 수정. 커맨드로 라우팅되므로 autogoal이 삼키지 않음.
- naked `key` (= `auth key`): 자기 전용 llmux 클라이언트 키 + 로컬 Claude Code 실행법(`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`)을 DM으로 받음. 같은 유저는 항상 같은 키 — 봇 사용량과 로컬 사용량이 한 테넌트로 계측된다. 모든 유저 사용 가능(자기 키이므로), 시크릿은 DM으로만 전달.
- 전체 명령어 표와 마이그레이션 히스토리(#506, #508)는 [README.md의 Commands 섹션](./README.md#commands)을 참고하세요.
- naked 화이트리스트의 source of truth: [`src/slack/z/whitelist.ts`](./src/slack/z/whitelist.ts)
- `$model` 등 legacy `$` 세션 설정은 deprecation grace period 동안만 허용 (경고 후 `%` 사용 안내)

---

## 실행 경로 두 가지

들어오는 길은 **두 개**이고, 서로 대체 가능하지 않다.

| 경로 | 무엇인가 | 지금 상태 |
|---|---|---|
| **패키지 온보딩** — `somawork setup` | 설치된 불변 macOS ARM64 런타임 + 재개 가능한 터미널 위저드 하나. llmux를 띄우고, Slack을 인가하고, 런타임 토큰을 직접 발급·수집하고, 프로파일을 materialize하고, doctor 게이트를 돌리고, 백그라운드 서비스를 설치한다. | 컨트롤러·위저드·런타임 번들은 **이 브랜치에 구현되어 있고 로컬 staged-bundle 스모크를 통과한다.** Homebrew/xbrew 포뮬러는 **미배포**이고, clean-user·실 Slack 리시트는 아직 없다. 아래 상태 박스를 먼저 읽어라. |
| **소스 개발** — 클론 후 실행 | 기존 경로: 레포 클론, Slack 앱 수동 생성, 로컬 `.env`에 토큰, `npm run dev`. | 오늘 지원되는 경로이며, 컨트리뷰터와 현행 플릿 배포가 쓰는 길이다. |

### 패키지 경로의 상태

이 경로의 명령을 입력하기 전에 먼저 읽어라.

**이 브랜치에 반영되었고 로컬에서 검증된 것**

- `somawork setup | doctor | status | service | profile | sessions`, 프로파일 materialization, Slack 매니페스트 훅, staged 런타임 번들 계약.
- `npm run stage:bundle && npm run smoke:setup-package`는 번들을 stage한 뒤 **staged** 컨트롤러를 외부 소비자처럼 실행한다: 격리된 `SOMAWORK_HOME`, 가짜 `HOME`, `PATH`에 Homebrew 없음, 프로바이더 호출 없음. 필수 경로·모드, 금지 파일 스캔, `--help` / `--version`, 패키징된 매니페스트에 대한 비공개 Slack 매니페스트 훅, 단일 JSON 문서 출력, 프로파일 격리, 그리고 런타임 루트에 아무것도 쓰지 않는 0700/0600 프로파일 materialization을 검사한다.

**아직 하지 않은 것 — 위를 릴리스로 읽지 마라**

- **배포된 Homebrew 포뮬러도, xbrew 레시피도 없다.** 오늘 `brew install somawork`는 해석되지 않는다. 패키징·릴리스 아카이브·탭 변경은 아직 실행되지 않은 별도 워크스트림이다.
- **clean-machine 설치도, 실제 Slack 워크스페이스 앱 생성도, 실제 `launchd` 리시트도 없다.** 위의 모든 것은 개발 머신의 staged 번들에 대해 증명된 것이다.
- 플랫폼은 **macOS ARM64 전용**. Linux 지원은 주장하지도 구현하지도 않았다.

### A. 패키지 온보딩 — 출하 후의 지원 경로

```bash
xbrew install somawork-preview   # 또는: xbrew install somawork   ← 포뮬러 아직 미배포
somawork setup                   # 런타임이 정확히 하나 설치돼 있으면 프로파일 자동 추론
```

`somawork setup`이 온보딩의 전부다. 재개 가능하다 — 중단 후 다시 실행하면(또는 `somawork setup --resume`) 오래된 마커를 믿는 대신 세계를 다시 검증한다.

무엇을 대신 해주고, 무엇을 **묻지 않는가**:

| 단계 | 담당 | 절대 묻지 않는 것 |
|---|---|---|
| Claude / Codex 프로바이더 인증 | llmux, 공식 브라우저 OAuth 플로우 | API 키 |
| Slack 앱 생성 + 설치 | Slack CLI 티켓/챌린지 → 패키징된 앱 매니페스트 | 매니페스트 붙여넣기 |
| Slack 런타임 자격증명 | Slack CLI 자체 훅에서 프로파일 전용 Unix 소켓을 통해 `0600 secrets.env`로 수집 | `xoxb-` / `xapp-` 복붙 |
| Signing secret | 사용하지 않음 — 매니페스트가 Socket Mode를 켠다 | signing secret |
| 프로파일 config·프롬프트·데이터 디렉터리 | 패키징된 `config.default.json`과 `.system.prompt.example`에서 materialize | 손으로 쓴 `.env` |
| 백그라운드 서비스 | 프로파일별 launchd user agent | plist |

컨트롤러 명령:

| 명령 | 용도 |
|---|---|
| `somawork setup [--profile preview\|production] [--resume]` | 온보딩 실행/재개. |
| `somawork doctor [--profile <p>] [--json]` | 프로파일 진단. `--json`은 정확히 한 개의 문서를 내고, detail에 파일시스템 경로가 없다. |
| `somawork status [--profile <p>] [--json]` | 프로파일·서비스 상태. `status --json`에는 절대 경로(plist, pid 파일, 로그 디렉터리)가 **들어간다** — 공개 이슈에 붙이기에는 `doctor --json`보다 덜 안전하다. |
| `somawork service <install\|start\|stop\|restart\|status> [--profile <p>]` | 백그라운드 서비스 관리. |
| `somawork profile <list\|show> [--profile <p>] [--json]` | 설치된 프로파일 조회. `profile remove`는 이번 릴리스에서 제공하지 않고 거부한다. |
| `somawork sessions <list\|show> [--profile <p>] [filters]` | 아카이브된 세션 조회. |
| `somawork help` · `somawork version` | 둘 다 런타임·프로파일·프로바이더를 건드리지 않고 답한다. |

프로파일은 완전히 격리된다 — `preview`와 `production`은 한 머신에 공존하며 경로도 서비스 식별자도 공유하지 않는다:

| | `preview` | `production` |
|---|---|---|
| config | `~/.config/somawork/profiles/preview` | `~/.config/somawork/profiles/production` |
| data | `~/.local/share/somawork/preview` | `~/.local/share/somawork/production` |
| state | `~/.local/state/somawork/preview` | `~/.local/state/somawork/production` |
| 서비스 레이블 | `ai.2lab.somawork.preview` | `ai.2lab.somawork.production` |

`SOMAWORK_HOME`이 프로파일 루트를 덮어쓰며, 격리 테스트용으로 지원되는 오버라이드다. `SOMA_HOME`은 **deprecated** 별칭으로만 허용되고, 둘 다 있으면 `SOMAWORK_HOME`이 이긴다.

**레거시 setup 진입점은 호환 shim이지 두 번째 설치 경로가 아니다.** `scripts/setup-wizard.sh`, `scripts/setup-wizard-macos.sh`, `scripts/new-deploy-setup.sh`는 deprecation 안내를 출력하고 `exec somawork setup`한다. 더 이상 토큰을 수집하지 않고, 레포 상대 `.env`를 쓰지 않고, `/opt/soma-work`를 만들지 않는다. `scripts/provision-agent.ts`도 마찬가지로 hard deprecation 래퍼다.

### B. 소스 개발 경로

지금 기여할 때 쓰는 경로이자, 현행 플릿 배포가 서 있는 경로다. 변경 없음.

#### 1. 클론 & 설치

```bash
git clone https://github.com/2lab-ai/soma-work.git
cd soma-work
npm install
```

#### 2. Slack App 수동 생성

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. [`infra/slack/slack-app-manifest.json`](./infra/slack/slack-app-manifest.json) 내용 붙여넣기

   > **매니페스트의 앱 이름은 `Somawork`** (이전: `[DEV] Claude Code Bot`). 예전 파일로 만든 앱에
   > 이 매니페스트를 붙여넣으면 **해당 앱과 봇 이름이 바뀐다.** 기존 이름을 유지하려면 저장 전에
   > `name` / `display_name` 두 필드를 직접 수정하라.
3. 앱 생성 후:
   - **OAuth & Permissions** → Bot User OAuth Token 복사 (`xoxb-...`)
   - **Basic Information** → `connections:write` 스코프로 App-Level Token 생성 (`xapp-...`)
   - **Basic Information** → Signing Secret 복사

> 패키지 경로에서는 이 과정이 전부 자동이다 — 위저드가 Slack CLI를 몰고 토큰을 출력 없이 수집한다.
> 이 절이 남아 있는 이유는 소스 체크아웃에는 매니페스트를 읽어올 패키징된 런타임이 없기 때문이다.

#### 3. 환경 설정

```bash
cp .env.example .env
```

```env
# 필수
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
# SLACK_SIGNING_SECRET=...  # optional: HTTP signature verification only (Socket Mode does not need it)
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

#### 4. MCP 서버 설정 (선택)

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

`config.json`의 최상위 `ui` 키로 스레드 헤더·턴 종료 카드·대시보드 카드
헤더의 표시 항목을 커스터마이즈할 수 있습니다. 기본값은 저장소 루트의
`config.default.json`(자동 생성, 직접 수정 금지)에서 확인하고, 원하는
섹션만 `config.json`에 복사해 수정하세요. 스키마: [docs/ui-surfaces.md](docs/ui-surfaces.md).

#### 5. 실행

```bash
npm run dev                        # 개발 (watch mode)
npm start                          # 개발 (tsx)
npm run build && npm run prod      # 프로덕션
```

---

## 배포

배포 모델이 두 개 공존하며, 경로도 서비스 레이블도 setup 절차도 공유하지 않는다.
위의 두 경로 중 어디에 서 있는지로 고른다.

| | 플릿 배포 (레거시, 현행) | 프로파일 패키지 (신규) |
|---|---|---|
| 단위 | 노드의 `/opt/soma-work/<env>` 체크아웃 또는 동기화된 번들 | 설치된 불변 런타임 + 사용자별 프로파일 |
| 설치 | GitHub self-hosted runner, 손으로 만든 Slack 앱, 노드의 `.env` | `somawork setup` |
| 서비스 | `scripts/service.sh` → `ai.2lab.soma-work[.<env>]` | `somawork service install` → `ai.2lab.somawork.<profile>` |
| 런북 | [docs/runbook/add-new-deploy.md](./docs/runbook/add-new-deploy.md) | 이 README의 패키지 온보딩 절 |
| 상태 | 현행 — 돌아가는 플릿이 쓰는 것 | 구현됨, 미배포 (위 상태 박스 참조) |

### 플릿 배포 — Docker

```bash
docker compose -f infra/docker/docker-compose.yml up -d
docker compose -f infra/docker/docker-compose.yml logs -f
```

### 플릿 배포 — macOS LaunchAgent

```bash
./scripts/service.sh install     # LaunchAgent 설치
./scripts/service.sh start       # 서비스 시작
./scripts/service.sh logs follow # 실시간 로그
```

서비스 식별자: `ai.2lab.soma-work` — 크래시 시 자동 재시작.

> ⚠️ **개발 중에는 `scripts/service.sh`를 사용하지 마세요.** 같은 Slack 토큰으로 여러 인스턴스가 실행되면 메시지 충돌이 발생합니다.

### 두 모델이 공유하는 런타임 번들

`scripts/deploy/stage-bundle.sh`가 불변 트리 하나를 stage한다. 플릿 배포는 그것을
노드로 rsync하고, 패키지 경로는 런타임 루트로 설치한다. 데몬, 서비스 supervisor,
실행 가능한 컨트롤러 엔트리, 그리고 세 개의 canonical setup asset
(`config.default.json`, `.system.prompt.example`, `infra/slack/slack-app-manifest.json`)을
담고, 자격증명·프로파일 상태·테스트·소스맵·TypeScript 소스는 담지 않는다.

```bash
npm run build
npm run stage:bundle              # → .deploy-bundle
npm run smoke:deploy-bundle       # 배포 + 워크스페이스 패키지 계약
npm run smoke:setup-package       # setup/런타임 계약, 외부 소비자 관점
```

`smoke:setup-package`는 staged 트리의 임시 하드링크 사본도 변형한다 — setup asset과
런타임 엔트리를 하나씩 제거하고, 금지 파일을 하나씩 주입한다. 그래서 green이면
소스 체크아웃에 파일이 있다는 뜻이 아니라 *번들*이 계약을 만족한다는 뜻이다.

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
scripts/                            # 배포 스테이징, 스모크, service.sh, deprecation shim
├── deploy/stage-bundle.sh          # 불변 런타임 번들 생성
├── smoke/setup-package.js          # staged 번들 setup/런타임 계약
└── setup/                          # DEPRECATED 셸 수집기 — 도달 불가, 번들에 없음

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
| 패키지 경로: 프로파일 이상 | `somawork doctor --profile <p>` — 위저드가 직접 돌리는 게이트이며, detail에 파일시스템 경로가 없어 `doctor --json`은 이슈에 붙여도 안전하다 |
| 패키지 경로: 서비스 미기동 | `somawork status --profile <p>` — 이쪽은 절대 경로를 **출력한다** |
| `brew install somawork`가 안 됨 | 정상이다. 아직 배포된 포뮬러가 없다 — [패키지 경로의 상태](#패키지-경로의-상태) 참조 |

---

## 라이선스

[MIT](./LICENSE)
