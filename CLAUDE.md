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
│   └── z/           # /z 명령어 surface + naked whitelist
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
└── local/           # Claude Code SDK 로컬 플러그인 (skills/, agents/, hooks/)

packages/            # 워크스페이스 패키지
├── mcp-servers/     # 내장 MCP 서버 (agent, cron, llm, model-command, permission, ...)
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

### Mock 전략

- **Slack Mock**: `src/test-utils/mock-slack-api.ts` — SlackApiHelper mock factory
- **Model Mock**: `src/test-utils/mock-claude-handler.ts` — ClaudeHandler mock factory
- **Session Mock**: `src/test-utils/mock-session.ts` — Session mock factory
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
| `git push origin main:deploy/dev` | dev | mac-mini dev, oudwood-512 dev |
| `git push origin main:deploy/prod` | prod (main) | mac-mini main |

수동 트리거도 가능:
```bash
gh workflow run deploy --ref main -f confirm=deploy
```

## Key Gotchas

- **듀얼 인스턴스 금지**: 같은 Slack 토큰으로 여러 인스턴스 실행 시 메시지 중복/충돌. 개발은 `npm start`만 사용.
- **고정 작업 디렉토리**: 각 유저별 `{BASE_DIRECTORY}/{userId}/` 고정. 유저가 직접 설정 불가 (보안 격리).
- **Git push multi-account**: `GITHUB_TOKEN`이 bot 토큰이라 push 불가 시:
  ```bash
  ICEDAC_TOKEN=$(gh auth token --user icedac)
  git push "https://icedac:${ICEDAC_TOKEN}@github.com/OWNER/REPO.git" BRANCH
  ```
- **Permission MCP Server**: `mcp-config-builder.ts`에서 `__filename` 기반 동적 확장자 사용 (.ts dev / .js prod). 하드코딩 금지.

## Command Surface

- 명령어 체계는 4개 prefix family: `/z <topic>` (영속) · `%<sub>` (세션 전용) · `$<skill>` (강제 스킬 발동) · naked whitelist. 상세는 `README.md`의 Commands 섹션. naked form의 source of truth는 두 층: `src/slack/z/whitelist.ts` + `CommandRouter`의 `CommandParser.is*Command` 매처(`auth`, `cct` 등 운영 카드).
- whitelist 외 네이키드 텍스트는 채팅 / 워크플로우 디스패치로 처리.
- **터미널 `somawork` 컨트롤러는 별개 surface다** (`setup` · `doctor` · `status` · `service` · `profile` · `sessions` · `help` · `version`). Slack prefix family와 아무 관계 없고, 문법의 SSOT는 `src/cli/args.ts`의 `COMMAND_GRAMMAR` + `publicCommandSummaries()` — help 텍스트가 그 테이블에서 생성되므로 drift할 수 없고, 비공개 훅 라우트는 절대 나타나지 않는다.
- **Migration (#506)**: whitelist 외의 legacy 네이키드 형태(`persona linus`, `model sonnet`, `show_prompt` 등)는 deprecated. 첫 사용 시 tombstone hint, 이후 drop. `SOMA_ENABLE_LEGACY_SLASH=true` 환경변수로 rollback 가능.

## Documentation Sync (Required)

**작업은 코드 + 테스트 + 문서가 모두 맞아야 완료다.** 코드만 바꾸고 끝내지 않는다.

모든 작업(기능 추가, 버그 수정, 리팩토링, 구조 변경)을 마무리할 때, 커밋/PR 전에 반드시:

1. `.claude/skills/update-docs/SKILL.md` 스킬을 따라 문서 drift를 점검한다.
2. 변경이 아래 표면에 영향을 주면 **같은 PR에서** 함께 업데이트한다:
   - `README.md` / `README.ko.md` — 기능, 명령어, 아키텍처, 프로젝트 구조, 설정 방법이 바뀌었을 때. 두 파일은 항상 같이 움직인다.
   - `CLAUDE.md` / `AGENTS.md` — agent 행동 규칙, 모듈 구조, gotcha가 바뀌었을 때.
   - `docs/README.md` — docs 디렉토리 구조나 라우팅이 바뀌었을 때.
   - `docs/misc/reference/architecture.md` — 컴포넌트 와이어링이 바뀌었을 때.
3. 문서에 영향이 없으면 PR 본문에 "docs: no impact"를 한 줄로 명시한다 — 점검을 건너뛴 것과 점검 후 영향 없음은 다르다.

문서 라우팅 규칙은 `docs/README.md`와 `rules/pattern.doc.md`를 따른다. 하드코딩된 숫자 카운트(핸들러 N개 등)는 문서에 넣지 않는다.
