# soma-work 실행

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
npm run build    # 워크스페이스 패키지는 dist/에서 로드된다 — 새로 클론했으면 실행 전에 한 번 빌드해야 한다
```

#### 2. Slack App 수동 생성

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. [`infra/slack/slack-app-manifest.json`](../../../infra/slack/slack-app-manifest.json) 내용 붙여넣기

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
SOMA_PR_WATCH=off                  # 턴이 끝난 뒤 세션 PR 감시 끄기 (기본 켜짐: 머지·닫힘이 카드와 스레드에 반영)
SOMA_PR_WATCH_BOTS=coderabbitai[bot]  # PR 리뷰로 세션을 깨워도 되는 리뷰 봇 (기본 없음; 레포 멤버는 항상 됨)
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
섹션만 `config.json`에 복사해 수정하세요. 스키마: [docs/ui-surfaces.md](../../../docs/ui-surfaces.md).

#### 5. 실행

```bash
npm run dev                        # 개발 (watch mode)
npm start                          # 개발 (tsx)
npm run build && npm run prod      # 프로덕션
```

## 배포

배포 모델이 두 개 공존하며, 경로도 서비스 레이블도 setup 절차도 공유하지 않는다.
위의 두 경로 중 어디에 서 있는지로 고른다.

| | 플릿 배포 (레거시, 현행) | 프로파일 패키지 (신규) |
|---|---|---|
| 단위 | 노드의 `/opt/soma-work/<env>` 체크아웃 또는 동기화된 번들 | 설치된 불변 런타임 + 사용자별 프로파일 |
| 설치 | GitHub self-hosted runner, 손으로 만든 Slack 앱, 노드의 `.env` | `somawork setup` |
| 서비스 | `scripts/service.sh` → `ai.2lab.soma-work[.<env>]` | `somawork service install` → `ai.2lab.somawork.<profile>` |
| 런북 | [docs/runbook/add-new-deploy.md](../../../docs/runbook/add-new-deploy.md) | 이 문서 위쪽의 패키지 온보딩 절 |
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

App을 쓰면 토큰을 갱신할 때마다 봇 전용 `gh` 설정(`$DATA_DIR/gh/hosts.yml`, 권한 0600)도 다시 씁니다. 그 파일이 쓰여 있는 동안 에이전트 셸은 그 디렉터리를 `GH_CONFIG_DIR`로 받고 `GITHUB_TOKEN`은 받지 않습니다(쓰기에 실패하면 env로 돌아갑니다). 그래서 `gh`는 긴 턴의 한 시간 뒤 만료되는 복사본이 아니라 매번 살아 있는 토큰을 읽습니다. `git`은 이미 갱신마다 다시 쓰는 자기 설정을 매번 읽습니다. 그래서 에이전트의 `gh`는 운영자의 `~/.config/gh`(별칭, 다른 호스트)를 보지 않습니다.

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
