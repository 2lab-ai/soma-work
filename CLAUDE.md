# soma-work

Slack에서 Claude Code SDK를 통해 AI 코딩 어시스턴트를 제공하는 TypeScript 봇.

## Slack Reference

- Slack UI/API/AI 앱 구현 기준 문서는 `docs/misc/reference/slack-block-kit.md`.
- Slack Block Kit payload 필드를 추가하거나 변경할 때는 `docs/misc/reference/slack-block-kit.md`의 제약과 공식 링크를 먼저 확인.

## Documentation Reference

- 문서 라우팅의 시작점은 `docs/README.md`.
- 완료/아카이브된 작업은 `docs/archive/completed-work.md`에 증거 링크 중심으로 정리.
- repo-wide architecture decision은 `docs/adr/README.md`와 `docs/adr/000N-*.md`에 기록.
- `CLAUDE.md`에는 반복적으로 필요한 agent 행동 규칙만 둔다. 완료 이력, 긴 조사 내용, changelog는 `docs/`로 보낸다.

## Rules (반복 패턴 — 코드 손대기 전 확인)

반복 적용되는 패턴 규칙은 `rules/`에 산다. 진입점: **`rules/README.md`**. 특히:

- `rules/auth.md` — Claude **API 인증** 단일 경로.
- `rules/permission.md` — **인가(도구 허용/거부)** 단일 결정 파이프라인. (인증≠인가)
- `rules/config.md` — **설정(env·파일) 단일 출처** + **상태 저장 원자성**.
- `rules/packaging.md` — **`@soma/*` 패키지 경계**. 추출은 이동(복사 금지), 이중 출처 해소.
- `verification/LEDGER.md` — **Lean 검증 대장**. `T2:<Module>` 파일은 Lean 모델이 있다: 동작을 바꾸면
  `verification/lean/SomaVerify/<Module>/Model.lean`(+증명)을 함께 고치고 `npm run verify:lean`으로 벡터를 재생성한다.
  전체 import 그래프 정리(레이어링·CLI 로드 순수성·MCP stdio 순수성)는 CI **Lean Verify**가 매번 다시 증명한다.

config·permission·packaging 횡단 부채 맵: `docs/current/spec/architecture-map.md` (전체 와이어링 SSOT는 `docs/misc/reference/architecture.md`).

## Architecture

**Facade Pattern** — 복잡한 서브시스템을 단순한 인터페이스로 제공:

| Facade | 역할 | 위임 대상 |
|--------|------|----------|
| `SlackHandler` | Slack 이벤트 처리 | `EventRouter`, `CommandRouter`, `StreamProcessor` |
| `ClaudeHandler` | Claude SDK 통합 | `SessionRegistry`, `PromptBuilder`, `McpConfigBuilder` |
| `McpManager` | MCP 서버 관리 | `ConfigLoader`, `ServerFactory`, `InfoFormatter` |
| `AgentManager` | 멀티 에이전트 인스턴스 기동 | `AgentInstance` (App + Handler per agent) |

**Pipeline**: `InputProcessor` → `SessionInitializer` (dispatch + onboarding + channel routing) → `StreamExecutor`

### Module Layout

숫자 카운트는 여기 적지 않는다 — 하드코딩된 카운트는 반드시 drift한다. 항상 디렉토리를 직접 확인.
config·permission·packaging 횡단 관심사 맵: `docs/current/spec/architecture-map.md`.

```
src/
├── slack/           # Slack 모듈 (SRP 분리)
│   ├── actions/     # 인터랙티브 액션 핸들러
│   ├── pipeline/    # 스트림 처리 파이프라인
│   ├── commands/    # 명령어 핸들러
│   ├── directives/  # 채널/세션 링크 디렉티브
│   ├── formatters/  # 출력 포맷터
│   └── z/           # /z 명령어 surface + 비-admin DM 입력 게이트
├── agent-runtime/   # Claude Agent SDK 실행 런타임
├── auth/            # CCT lease + query env 주입
├── conversation/    # 대화 기록 및 리플레이
├── model-commands/  # 모델 커맨드 카탈로그 & 검증
├── mcp/             # MCP 서버 관리
├── github/          # GitHub App 인증 + Git 자격증명
├── permission/      # Slack 권한 프롬프트
├── plugin/          # 플러그인 시스템 (마켓플레이스, 캐시)
├── prompt/          # 시스템 프롬프트 + workflows/ (디스패치 워크플로우)
├── persona/         # 봇 페르소나
├── sandbox/         # 실행 샌드박스 게이트
├── metrics/         # 토큰/비용 텔레메트리
├── notification-channels/  # Slack·DM·Telegram·Webhook 출력 라우팅
├── cli/             # `somawork` 컨트롤러 (데몬과 별개 프로세스 — 아래 참조)
│   ├── index.ts     # 라우터: 공개 커맨드 + 비공개 Slack 훅 라우트
│   ├── args.ts      # 커맨드별 문법 테이블 (토큰 1개당 정확히 1회 소비)
│   ├── doctor.ts    # 주입된 seam만 쓰는 진단 게이트
│   ├── profile.ts   # ProfileName + 프로파일 경로/서비스 식별자
│   ├── service.ts   # launchd user agent 설치/기동
│   ├── production-seams.ts  # 실제 배선 + 패키징된 asset 경로 상수
│   └── setup/       # 온보딩 state machine (orchestrator, materialize, slack-*, llmux)
├── local-harness/   # soma-work 전용 플러그인 `local` — 하네스 MCP(작업 카드)를 부르는 스킬 (auto-es). 마켓플레이스에 없음
└── local/           # Claude Code SDK 로컬 플러그인 `zworkflow` (skills/, agents/, hooks/) — 범용, 하네스 호출 금지

packages/            # 워크스페이스 패키지
├── mcp-servers/     # 내장 MCP 서버 (agent, cron, model-command, permission, devops-tools, ...)
├── devops-broker/   # 별도 OS 유저 브로커 — gh 토큰·Cloudflare forge 키 보관, admin 승인 카드
├── common/ · slack/ · process-shared/ · test-utils/

somalib/             # soma 계열 공유 라이브러리 (model-commands, permission, cron)
services/a2t/        # 음성→텍스트 Python worker
infra/               # docker / slack manifest / claude 설정
scripts/deploy/      # stage-bundle.sh — 불변 런타임 번들 생성
scripts/smoke/       # deploy-bundle.js (배포 계약) · setup-package.js (setup/런타임 계약)
scripts/setup/       # DEPRECATED 셸 수집기 — 도달 불가, 번들 제외, 삭제 대기
```

전체 컴포넌트 와이어링은 `docs/misc/reference/architecture.md`가 SSOT.

### Controller vs daemon — 한 레포, 두 프로세스

`src/cli/`(컨트롤러 `somawork`)와 `src/index.ts`(데몬)는 다른 프로세스이고 규칙이 다르다.

- 컨트롤러는 **프로바이더도 Slack도 launchd도 직접 부르지 않는다.** 모든 효과는 주입된 seam으로 들어오고, 실제 배선은 `production-seams.ts` 한 곳에만 있다.
- `--json` 라우트의 stdout은 **정확히 한 개의 문서**다. 그래서 JSON 바디는 ambient stdout/stderr/console을 캡처한 뒤 하나의 큐(`withJsonOutputLock`)로 직렬화한다. 캡처를 새로 추가하는 바디는 반드시 그 큐 안에 있어야 한다 — 비공개 `_print-slack-manifest` 라우트도 포함이다(그 stdout이 곧 JSON 문서다).
- 어떤 에러 메시지도 그대로 출력하지 않는다. 허용 목록(`describeCliError`)에 없으면 고정 문구 + 검증된 클래스 이름뿐이다.
- `src/cli/`가 import하는 모듈은 **module load 시 부수효과가 없어야** 한다. `@soma/common/env-paths`는 로드 시 `git`을 실행하고 배너를 출력하므로, 순수 리졸버는 `@soma/common/soma-paths`에 있다. 여기서 실수하면 `--json` 첫 바이트가 배너가 된다.
- 프로파일 홈 오버라이드는 `SOMAWORK_HOME`이 정본, `SOMA_HOME`은 deprecated 별칭.

### 런타임 번들 계약

`scripts/deploy/stage-bundle.sh`가 만드는 트리 하나를 플릿 배포와 패키지 설치가 함께 쓴다.
런타임 루트 기준 고정 경로: `dist/cli/index.js`(실행 비트 필수) · `dist/run-with-rotating-logs.js` ·
`dist/index.js` · `config.default.json` · `.system.prompt.example` ·
`infra/slack/slack-app-manifest.json`. 자격증명·프로파일 상태·테스트·소스맵·TypeScript 소스는
들어가지 않는다.

번들 경로를 바꾼다면 `src/cli/production-seams.ts` 상수, `stage-bundle.sh` 복사 목록,
그리고 **두 스모크 모두**를 같은 커밋에서 고친다:

```bash
npm run build && npm run stage:bundle
npm run smoke:deploy-bundle && npm run smoke:setup-package
```

`smoke:setup-package`는 소스 트리가 아니라 **staged 트리**를 검사하고, 하드링크 사본에서
asset을 하나씩 지워 실패하는지까지 확인한다. 소스에 파일이 있다는 사실은 번들에 있다는 증거가
아니다.

## Design Decisions

1. **Facade Pattern**: 복잡한 서브시스템을 단순한 인터페이스로 제공
2. **Single Responsibility**: 각 모듈이 하나의 책임만 담당
3. **Pipeline Architecture**: 입력 전처리 → 세션 초기화 → 스트림 실행
4. **Append-Only Messages**: Slack 메시지 편집 대신 새 메시지 추가
5. **Session-Based Context**: 대화별 세션 유지
6. **Hierarchical CWD**: Thread > Channel > User 우선순위
7. **Workflow Dispatch**: 입력 분류 → 전문 워크플로우 프롬프트 적용
8. **Dependency Injection**: 테스트 용이성을 위한 의존성 주입

## Testing (TDD Required)

**모든 코드 변경은 Red-Green-Refactor TDD 프로세스 필수.**

### 워크플로우

1. **RED**: 실패하는 테스트 작성 → `npx vitest run` → 테스트 실패 확인
2. **GREEN**: 최소한의 구현 → `npx vitest run` → 테스트 통과 확인
3. **REFACTOR**: 코드 정리 → 테스트 여전히 통과 확인

### Push 규칙

- TDD 증명(RED→GREEN 로그) 없으면 `git push` 금지
- 커밋 전 반드시: `npx tsc --noEmit && npx vitest run`
- 새 기능/버그 수정 시 테스트가 먼저 존재해야 함

### 테스트 환경 격리

vitest `setupFiles`(`src/test-utils/vitest-setup.ts`)가 모든 테스트 파일 실행 전에 env를 허용 목록으로 줄이고
`SOMA_CONFIG_DIR`/`DATA_DIR`를 파일별 scratch 디렉터리로 고정한다. 그래서 배포 노드나 봇이 띄운 에이전트 셸
(`SOMA_CONFIG_DIR=/opt/soma-work/<env>`)에서 돌려도 그 배포의 `.env`·자격증명·data 디렉터리에 닿지 않는다.
테스트가 env 변수가 필요하면 테스트 안에서 직접 설정한다 — 셸에서 물려받는 값에 기대지 않는다.

### Mock 전략

- **Slack Mock**: `@soma/test-utils` (`packages/test-utils/src/mock-slack-api.ts`) — SlackApiHelper mock factory
- **Model Mock**: `@soma/test-utils` (`packages/test-utils/src/mock-claude-handler.ts`) — ClaudeHandler mock factory
- **Session Mock**: `@soma/test-utils` (`packages/test-utils/src/mock-session.ts`) — Session mock factory
- 모든 기능은 Mock 기반 e2e 테스트 커버리지 확보 목표

## Deployment

배포 모델이 둘이다. 섞지 마라.

- **플릿 배포 (레거시, 현행)** — 아래 브랜치 push. `/opt/soma-work/<env>` + `scripts/service.sh` +
  노드의 `.env`. 런북은 `docs/runbook/add-new-deploy.md`.
- **프로파일 패키지 (신규)** — `somawork setup` / `somawork service install`. 프로파일별 경로와
  `ai.2lab.somawork.<profile>` 레이블. **아직 포뮬러가 배포되지 않았고 clean-machine·실 Slack
  리시트도 없다** — 구현이 끝났다는 것과 출하됐다는 것을 문서에서 섞지 마라.

main 머지 시 자동 배포 없음. 명시적 브랜치 push로만 배포된다.

| 명령 | 대상 환경 | 배포 호스트 |
|------|----------|------------|
| `git push origin main:deploy/dev` | dev | repo 변수 `PREVIEW_DEPLOY_TARGETS`의 dev 호스트 |
| `git push origin main:deploy/prod` | prod (main) | repo 변수 `PRODUCTION_DEPLOY_TARGETS`의 호스트 |

수동 트리거도 가능:
```bash
gh workflow run deploy --ref main -f confirm=deploy
```

## Key Gotchas

- **듀얼 인스턴스 금지**: 같은 Slack 토큰으로 여러 인스턴스 실행 시 메시지 중복/충돌. 개발은 `npm start`만 사용.
- **고정 작업 디렉토리**: 각 유저별 `{BASE_DIRECTORY}/{userId}/` 고정. 유저가 직접 설정 불가 (보안 격리).
- **Git push = 봇 identity만**: 봇 세션은 봇 자신의 GitHub App 토큰으로 push한다. `git`은 갱신마다 다시 쓰이는 gitconfig를, `gh`는 `GH_CONFIG_DIR`(`$DATA_DIR/gh/hosts.yml`, 갱신마다 다시 씀)를 읽는다 — 그 hosts.yml이 쓰여 있는 동안 에이전트 env에 `GITHUB_TOKEN`은 없다(쓰기에 실패하면 env로 돌아간다. 턴 시작 때 복사된 토큰은 한 시간 뒤 만료되어 `gh`가 401을 냈다, #834). 사람 gh 계정의 토큰을 꺼내 쓰지 마라 — `devops-secret-guard`가 `gh auth token` · `gh auth status --show-token` · `gh auth git-credential` · 키체인 덤프를 모든 봇·모든 권한 모드·admin까지 거부한다.
  계정별 gh 작업은 `devops-tools` MCP(`gh_read`, `gh_write` — 쓰기는 브로커 Slack 카드에 admin ✅ 필요)로 한다. 그 배포에 devops-tools가 없거나 거부되면 유저에게 알린다.
  App identity로 push가 안 되면(그 repo에 앱 미설치, workflow 파일 변경 등) 우회하지 말고 멈춰서 유저에게 알린다.
- **공개 레포 — 호스트 이름·타사 이름 금지 (Sanitize Gate)**: `.github/workflows/sanitize-gate.yml`이 공개된 모든 커밋(파일·커밋 메시지·author 줄·브랜치/태그 이름)을 비밀 패턴으로 검사한다. 패턴은 두 secret에만 있다 — `SANITIZE_PATTERNS_SHARED`(2lab-ai/llmux와 같은 값: 사설 호스트 이름, 다른 회사 이름·도메인)와 이 레포 전용 `SANITIZE_PATTERNS`. 스크립트 `scripts/sanitize-scan.sh`는 llmux에 같은 사본이 있다 — 고치면 둘 다 고친다. 문서·주석·커밋 메시지에는 머신 이름 대신 "owner-mac", "공유 호스트"처럼 쓴다. 워크플로가 특정 러너를 골라야 하면 라벨을 repo 변수(`vars.CONTROL_RUNNER_LABEL`, `PREVIEW_DEPLOY_TARGETS`)에 둔다. 걸리면 커밋을 고쳐 쓴다(`git commit --amend`, force-push). 이미 공개된 커밋도 예외 목록에 올리지 않고 히스토리를 고쳐 쓴다(2026-11-12 전체 재작성). `scripts/sanitize-known-leaks.txt`는 비어 있다. 레포를 공개하거나 비공개 흔적을 히스토리째 지울 때는 `local:chore-open-source` 스킬 절차(조사 → 규칙 → 게이트 → 재작성 → 승인 후 교체 → clone 이전)를 따른다.
- **Permission MCP Server**: `mcp-config-builder.ts`에서 `__filename` 기반 동적 확장자 사용 (.ts dev / .js prod). 하드코딩 금지.
- **비밀 저장소 `secrets/` (env-access WU1)**: 배포 설정의 비밀은 `<config dir>/secrets/<name>` 파일에 두고 설정은 `{"$secret": "<name>"}`로 가리킨다(`@soma/process-shared/secret-ref`). 어떤 모델도(어드민 포함) 파일 도구로 그 폴더를 읽거나 승인·grant 기록(`.bak` 포함)을 다루지 못한다 — 정책 1b(`devops-secret-guard.ts`) + CLI deny 규칙 + 샌드박스 `denyRead`/`denyWrite`. 샌드박스는 fail-closed(`failIfUnavailable: true`, 예외 `SOMA_SANDBOX_ALLOW_UNAVAILABLE`). 새 env-paths mock에는 `SECRETS_DIR`를 넣는다.
- **어드민도 샌드박스 안 (env-access WU2, #1210)**: 어드민 세션은 어드민 프로필(모든 도메인·gh TLS·로컬 서버·임시 디렉터리)로 돈다. 어드민의 네이티브 Write·Edit도 샌드박스 Bash와 같은 뿌리로 묶인다. 홈 캐시는 어느 세션도 쓰지 못한다(봇이 샌드박스 밖에서 `npx -y` MCP 코드를 꺼내 쓰는 곳) — 캐시를 env로 옮기지도 마라: `options.env`는 stdio MCP 자식이 그대로 물려받는다. 샌드박스 안 설치는 그 명령에만 캐시를 준다(`npm install --cache /tmp/{uid}/npm`, pnpm `--store-dir`, `PIP_CACHE_DIR=…`, `UV_CACHE_DIR=…`, `GOCACHE=…`). `sandbox off`는 호스트 `.env`의 `SOMA_SANDBOX_OFF_ALLOWED=true`가 있을 때만 효과가 있다. 모든 세션은 배포(설정 디렉터리·실행 코드 루트·봇 cwd)·`DATA_DIR`·plugins·홈의 시작 파일을 쓰지 못하고(`Edit` 거부 규칙), 사람·호스트의 자격 파일(`~/.ssh`·`~/.config/gh`·`~/.aws` …)을 읽지 못한다 — 봇 자신의 GitHub App 토큰(`~/.gitconfig`의 `insteadOf`, `$DATA_DIR/gh/hosts.yml`)은 git·gh가 쓰도록 의도적으로 읽힌다. Bash ssh는 어드민까지 금지 — 호스트 명령은 server-tools `ssh_exec`(어드민 전용)로 한다. 규칙 모음은 `src/sandbox/admin-sandbox-profile.ts`. 프로젝트 설정·프로젝트 MCP 설정·`.claude` 설정 트리는 작업 디렉터리가 아니라 `projectConfigRoot`(`DATA_DIR/session-project-config`, 비어 있어야 하고 아니면 세션이 시작되지 않는다)에서 읽힌다 — 모델이 쓰는 작업 디렉터리의 `.claude/settings.json` 훅이나 `.mcp.json` 서버를 CLI가 샌드박스 밖에서 돌리지 않게(#1242, `src/sandbox/project-config-root.ts`). CLAUDE.md와 계획 파일은 그대로 작업 디렉터리에서. stdio MCP 서버(플러그인 것 포함)는 작업 디렉터리가 아니라 `DATA_DIR/mcp-launch`에서 `sh -c 'cd … && exec …'`로 시작한다 — npx·uvx 같은 런처가 모델이 심은 패키지 설정(`.npmrc`·`package.json`·`uv.toml` …)을 샌드박스 밖에서 읽지 않게(#1241, `src/sandbox/mcp-launch-dir.ts`). CLI는 서버 설정의 `cwd`를 무시한다. 플러그인은 `skipMcpDiscovery`로 싣고, 그 서버는 soma-work가 CLI와 같은 이름(`plugin_<plugin>_<server>`, 도구 이름 그대로)으로 선언한다. CLI를 올릴 때마다 `scripts/verification/probe-cli-project-config-root.mjs`와 `probe-cli-mcp-launch-dir.mjs`를 다시 돌린다.

## Command Surface

- 명령어 체계는 4개 prefix family: `/z <topic>` (영속) · `%<sub>` (세션 전용) · `$<skill>` (강제 스킬 발동) · naked(bare `[cmd] [args]`). 상세는 `docs/misc/guides/commands.md`. naked form의 source of truth는 `CommandRouter` 핸들러 체인(`CommandParser.is*Command` 매처 포함 — `auth`, `cct` 등 운영 카드). 비-admin DM에서 받는 입력은 `isDmAllowedForNonAdmin`(`packages/slack/src/z/whitelist.ts`)이 정한다.
- 어느 핸들러도 잡지 않은 네이키드 텍스트는 채팅 / 워크플로우 디스패치로 처리.
- **터미널 `somawork` 컨트롤러는 별개 surface다** (`setup` · `doctor` · `status` · `service` · `profile` · `sessions` · `help` · `version`). Slack prefix family와 아무 관계 없고, 문법의 SSOT는 `src/cli/args.ts`의 `COMMAND_GRAMMAR` + `publicCommandSummaries()` — help 텍스트가 그 테이블에서 생성되므로 drift할 수 없고, 비공개 훅 라우트는 절대 나타나지 않는다.
- **Bare 명령 (#531)**: `persona linus`, `model sonnet` 같은 bare `[cmd] [args]` 형태는 `CommandRouter` 핸들러가 그대로 실행한다 (#506 Phase 1의 tombstone 힌트는 #531에서 제거됐다). `SOMA_ENABLE_LEGACY_SLASH=true`는 legacy 슬래시 커맨드 `/soma` · `/session` · `/new`만 되살린다.

## Documentation Sync (Required)

**작업은 코드 + 테스트 + 문서가 모두 맞아야 완료다.** 코드만 바꾸고 끝내지 않는다.

모든 작업(기능 추가, 버그 수정, 리팩토링, 구조 변경)을 마무리할 때, 커밋/PR 전에 반드시:

1. `.claude/skills/update-docs/SKILL.md` 스킬을 따라 문서 drift를 점검한다.
2. 변경이 아래 표면에 영향을 주면 **같은 PR에서** 함께 업데이트한다:
   - `README.md` / `README.ko.md` — 첫 화면(맨 위에 데모 영상 포스터 `assets/readme/{en,ko}/demo-poster.png` → v0.3 릴리스의 언어별 영상, 바로 밑에 포스터 두 장 `usage-poster.png`(실제 사용 데모)·`llmux-poster.png`(soma-work × llmux) → 같은 v0.3 릴리스 영상, 실행하기 2단계에 llmux 소개 영상 링크(llmux v0.2.26 릴리스), 그 아래 독자가 묻는 순서: 슬랙에서 시키기 → 대시보드에서 확인 → 카드에서 이어서 → 지켜보기 → 대시보드에서 바로 시키기 → 끼어들기 → 돌아오는 것 → 실행하기)과 그 스크린샷·GIF가 바뀌었을 때. 화면은 언어별로 따로 찍는다: `README.md`는 영문 UI(`assets/readme/en/`), `README.ko.md`는 한글 UI(`assets/readme/ko/`). 두 파일은 항상 같이 움직인다.
   - `docs/misc/guides/{features,commands,setup,contributing}.md`와 각 `.ko.md` 짝 — 기능, 명령어, 아키텍처, 프로젝트 구조, 설정 방법이 바뀌었을 때. 영문과 한글 파일은 같이 움직인다.
   - `CLAUDE.md` / `AGENTS.md` — agent 행동 규칙, 모듈 구조, gotcha가 바뀌었을 때.
   - `docs/README.md` — docs 디렉토리 구조나 라우팅이 바뀌었을 때.
   - `docs/misc/reference/architecture.md` — 컴포넌트 와이어링이 바뀌었을 때.
3. 문서에 영향이 없으면 PR 본문에 "docs: no impact"를 한 줄로 명시한다 — 점검을 건너뛴 것과 점검 후 영향 없음은 다르다.

문서 라우팅 규칙은 `docs/README.md`와 `rules/pattern.doc.md`를 따른다. 하드코딩된 숫자 카운트(핸들러 N개 등)는 문서에 넣지 않는다.
