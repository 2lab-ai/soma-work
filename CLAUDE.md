**"Use 'bd' for task tracking"**

## bd Task Lifecycle

```
open → in_progress → phase:review → closed (with evidence)
```

| 단계 | 명령 | 의미 |
|------|------|------|
| 작업 시작 | `bd update <id> --status in_progress` | 코딩 시작 |
| 리뷰 전환 | `bd set-state <id> phase=review --reason "구현 내용 요약"` | 구현 완료, 코드 리뷰 대기 |
| 리뷰 통과 | `bd close <id> --reason "근거"` | **반드시 close reason에 근거 기재** |

### close 시 필수 근거 (--reason)

`bd close`할 때 아래 중 해당하는 항목을 `--reason`에 명시해야 함:

- **테스트**: 통과한 테스트 결과 (예: "vitest 423 passed, 0 new failures")
- **빌드**: 컴파일 성공 여부 (예: "tsc --noEmit clean")
- **코드 리뷰**: 누가 리뷰했는지 (예: "Oracle agent reviewed, feedback addressed")
- **변경 범위**: 실제 변경된 파일과 라인 수 (예: "5 files, +491 lines")
- **수정 없는 경우**: 왜 수정 불필요한지 (예: "config-only change, no logic")

```bash
# 올바른 예시
bd close <id> --reason "tsc clean, vitest 423 passed (0 new failures), Oracle reviewed, 5 files +491 lines"

# 잘못된 예시 (근거 없음)
bd close <id>
bd close <id> --reason "done"
bd close <id> --reason "구현 완료"
```

### 기타 규칙

- **구현 완료 시 바로 `bd close` 하지 말 것** — 반드시 `phase=review` 거쳐야 함
- 리뷰 대기 목록: `bd list --status=in_progress --label phase:review`
- 리뷰에서 수정 필요 시: `bd set-state <id> phase=coding --reason "리뷰 피드백 반영"`

# soma-work

Slack에서 Claude Code SDK를 통해 AI 코딩 어시스턴트를 제공하는 TypeScript 기반 봇.

## Codebase Stats

| 항목 | 수치 |
|------|------|
| 소스 파일 (`.ts`, 테스트/로컬 제외) | 85개, ~13,800줄 |
| 테스트 파일 (`.test.ts`) | 20개, ~5,600줄 |
| 페르소나 (`.md`) | 12개, ~4,700줄 |
| 프롬프트 (`.prompt` + `.md`) | 12개, ~1,900줄 |
| 로컬 SDK 파일 (`src/local/`) | 58개 |

## Architecture

### Facade Pattern
복잡한 서브시스템을 단순한 인터페이스로 제공:

| Facade | 역할 | 위임 대상 |
|--------|------|----------|
| `SlackHandler` | Slack 이벤트 처리 | `EventRouter`, `CommandRouter`, `StreamProcessor` 등 |
| `ClaudeHandler` | Claude SDK 통합 | `SessionRegistry`, `PromptBuilder`, `McpConfigBuilder` |
| `McpManager` | MCP 서버 관리 | `ConfigLoader`, `ServerFactory`, `InfoFormatter` |

### Core Components (src/*.ts)

| 파일 | 줄수 | 역할 |
|------|------|------|
| `index.ts` | 192 | 진입점 |
| `config.ts` | 211 | 환경 설정 |
| `slack-handler.ts` | 314 | Slack 이벤트 처리 (facade) |
| `claude-handler.ts` | 381 | Claude SDK 통합 (facade) |
| `session-registry.ts` | 522 | 세션 생명주기 관리 |
| `prompt-builder.ts` | 298 | 시스템 프롬프트 + 페르소나 조립 |
| `dispatch-service.ts` | 368 | 워크플로우 디스패치 |
| `mcp-config-builder.ts` | 137 | MCP 설정 조립 |
| `working-directory-manager.ts` | 135 | 작업 디렉토리 관리 |
| `file-handler.ts` | 259 | 파일 업로드 처리 |
| `image-handler.ts` | 38 | 이미지 변환/인코딩 |
| `todo-manager.ts` | 145 | 태스크 추적 |
| `mcp-manager.ts` | 75 | MCP 서버 관리 (facade) |
| `mcp-client.ts` | 400 | MCP JSON-RPC 클라이언트 |
| `mcp-call-tracker.ts` | 259 | MCP 호출 통계/예측 |
| `permission-mcp-server.ts` | 248 | Slack 권한 프롬프트 MCP |
| `shared-store.ts` | 254 | IPC용 파일 기반 스토어 |
| `github-auth.ts` | 202 | GitHub App 인증 (facade) |
| `credentials-manager.ts` | 195 | Claude 자격증명 관리 |
| `credential-alert.ts` | 130 | 자격증명 알림 |
| `git-cli-auth.ts` | 62 | Git CLI 인증 |
| `user-settings-store.ts` | 384 | 사용자 설정 저장 |
| `logger.ts` | 131 | 로깅 유틸리티 |
| `stderr-logger.ts` | 47 | stderr 로깅 |
| `types.ts` | 154 | 타입 정의 |

### Modular Directories

```
src/slack/                          # Slack 모듈 (SRP 분리)
├── event-router.ts            272  # 이벤트 라우팅 (DM, mention, thread)
├── stream-processor.ts        512  # Claude SDK 스트림 처리
├── tool-event-processor.ts    202  # tool_use/tool_result 처리
├── request-coordinator.ts      85  # 세션별 동시성 제어
├── tool-tracker.ts            120  # 도구 사용 추적
├── message-validator.ts       122  # 메시지 검증
├── status-reporter.ts         131  # 상태 메시지 관리
├── todo-display-manager.ts    152  # 태스크 UI 관리
├── command-parser.ts          262  # 명령어 파싱
├── tool-formatter.ts          370  # 도구 출력 포맷팅
├── user-choice-handler.ts      42  # 사용자 선택 UI
├── user-choice-extractor.ts   168  # 사용자 선택 추출
├── choice-message-builder.ts  384  # 선택 UI 빌더
├── message-formatter.ts       110  # 메시지 포맷팅
├── slack-api-helper.ts        367  # Slack API 래퍼
├── reaction-manager.ts        183  # 리액션 상태 관리
├── mcp-status-tracker.ts      191  # MCP 상태 UI
├── session-manager.ts         359  # 세션 UI 관리
├── action-handlers.ts          14  # 버튼 액션 처리 (엔트리)
├── context-window-manager.ts  125  # 컨텍스트 윈도우 추적
├── permission-validation.ts     -  # 권한 검증
│
├── actions/                        # 액션 핸들러 모듈
│   ├── choice-action-handler.ts    327  # 선택 액션
│   ├── form-action-handler.ts      256  # 폼 액션
│   ├── permission-action-handler.ts 66  # 권한 액션
│   ├── session-action-handler.ts    93  # 세션 액션
│   ├── pending-form-store.ts       111  # 대기 폼 저장소
│   ├── types.ts                     34  # 액션 타입
│   └── index.ts                    183  # 액션 라우팅
│
├── pipeline/                       # 스트림 처리 파이프라인
│   ├── input-processor.ts           77  # 입력 전처리
│   ├── session-initializer.ts      317  # 세션 초기화
│   ├── stream-executor.ts          543  # 스트림 실행
│   ├── types.ts                     44  # 파이프라인 타입
│   └── index.ts                      4  # 엔트리
│
├── formatters/                     # 포맷터 모듈
│   └── directory-formatter.ts       77  # 디렉토리 포맷
│
└── commands/                       # 명령어 핸들러
    ├── command-router.ts            95  # 명령어 라우팅
    ├── cwd-handler.ts               50  # cwd 명령
    ├── mcp-handler.ts               47  # mcp 명령
    ├── bypass-handler.ts            39  # bypass 명령
    ├── persona-handler.ts           53  # persona 명령
    ├── model-handler.ts             61  # model 명령
    ├── session-handler.ts           48  # sessions 명령
    ├── help-handler.ts              22  # help 명령
    ├── restore-handler.ts          104  # restore 명령
    ├── new-handler.ts               69  # new 명령
    ├── renew-handler.ts             75  # renew 명령
    ├── context-handler.ts           95  # context 명령
    ├── types.ts                     61  # 명령어 타입
    └── index.ts                     16  # 엔트리

src/mcp/                            # MCP 모듈
├── config-loader.ts           136  # 설정 파일 로드/검증
├── server-factory.ts          174  # 서버 생성/GitHub 인증 주입
├── info-formatter.ts           74  # 상태 정보 포맷팅
└── index.ts                    10

src/github/                         # GitHub 모듈
├── api-client.ts              140  # GitHub API 클라이언트
├── git-credentials-manager.ts 148  # Git 자격증명 관리
├── token-refresh-scheduler.ts 155  # 토큰 자동 갱신
└── index.ts                     7

src/permission/                     # Permission 모듈
├── service.ts                 104  # 권한 서비스
├── slack-messenger.ts         153  # Slack 권한 메시지
└── index.ts                    11
```

### Prompt & Persona System
```
src/prompt/
├── default.prompt              44  # 기본 워크플로우 프롬프트
├── common.prompt               15  # 공통 설정 (MCP, 용어 정의)
├── dispatch.prompt             49  # 워크플로우 분류기
├── review_prompt.md            86  # PR 리뷰 가이드라인
└── workflows/                      # 워크플로우 프롬프트
    ├── jira-brainstorming.prompt    65  # Jira 브레인스토밍
    ├── jira-create-pr.prompt        88  # Jira PR 생성
    ├── jira-executive-summary.prompt 45  # Jira 요약 보고
    ├── jira-planning.prompt         80  # Jira 계획 수립
    ├── pr-docs-confluence.prompt   142  # PR 문서 → Confluence
    ├── pr-fix-and-update.prompt    115  # PR 수정 & 업데이트
    ├── pr-review.prompt             95  # PR 리뷰
    └── examples/
        └── PTN-1978-summary.md     601  # 요약 예시

src/persona/
├── default.md              41  # 기본 페르소나
├── chaechae.md            256  # 채채 페르소나
├── linus.md               495  # Linus Torvalds
├── buddha.md              500  # 부처
├── davinci.md             410  # 레오나르도 다 빈치
├── einstein.md            543  # 아인슈타인
├── elon.md                328  # 일론 머스크
├── feynman.md             457  # 리처드 파인만
├── jesus.md               449  # 예수
├── newton.md              472  # 아이작 뉴턴
├── turing.md              377  # 앨런 튜링
└── vonneumann.md          415  # 존 폰 노이만
```

### Test Files (20개, ~5,600줄)
```
src/slack/
├── action-handlers.test.ts           183
├── command-parser.test.ts            468
├── concurrency.test.ts               328
├── event-router.test.ts              336
├── mcp-cleanup.test.ts               441
├── mcp-status-tracker.test.ts        187
├── message-formatter.test.ts         161
├── permission-validation.test.ts     356
├── reaction-manager.test.ts          170
├── request-coordinator.test.ts       125
├── session-manager.test.ts           263
├── slack-api-helper.test.ts          286
├── stream-processor.test.ts          313
├── tool-event-processor.test.ts      201
├── tool-formatter.test.ts            352
├── tool-tracker.test.ts              181
├── user-choice-handler.test.ts       559
├── commands/context-handler.test.ts  246
└── pipeline/
    ├── session-usage.test.ts         251
    └── stream-executor.test.ts       214
```

### Data Files
```
data/
├── user-settings.json      # 사용자별 설정 (cwd, bypass, persona, model 등)
├── sessions.json           # 활성 세션 정보
├── mcp-call-stats.json     # MCP 호출 통계
├── slack_jira_mapping.json # Slack-Jira 사용자 매핑
└── pending-forms.json      # 대기 중인 폼 데이터
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
- `new` / `renew` 명령으로 세션 초기화/갱신

### 3. Workflow Dispatch
- `dispatch.prompt`로 사용자 입력을 워크플로우로 분류
- Jira 기반: 브레인스토밍, 계획, 요약, PR 생성
- PR 기반: 리뷰, 수정, Confluence 문서화
- 기본 워크플로우 (`default.prompt`) 폴백

### 4. Real-Time Task Tracking
```
Task List
In Progress: Analyze auth system
Pending: Implement OAuth, Add error handling
Progress: 1/3 (33%)
```

### 5. MCP Integration
- stdio/SSE/HTTP 서버 지원
- `mcp` - 설정된 서버 목록
- `mcp reload` - 설정 리로드
- 호출 통계 및 예상 시간 추적

### 6. Permission System
- Slack 버튼으로 권한 승인/거부
- `bypass` / `bypass on` / `bypass off` - 권한 프롬프트 우회 설정

### 7. File Upload
- 이미지: JPG, PNG, GIF, WebP (분석용)
- 텍스트/코드: 프롬프트에 직접 임베딩
- 50MB 제한, 자동 정리

### 8. GitHub Integration
- GitHub App 인증 (권장) 또는 PAT 폴백
- 자동 토큰 갱신 (만료 5분 전)
- Git CLI 자동 인증

### 9. Interactive Actions
- `src/slack/actions/` 모듈로 Slack 인터랙티브 UI 처리
- 선택 액션, 폼 액션, 권한 액션, 세션 액션
- `pending-form-store.ts`로 대기 폼 상태 관리

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
| `persona [name]` | AI 페르소나 변경 |
| `model [name]` | 사용 모델 변경 (sonnet, opus, haiku) |
| `sessions` | 활성 세션 목록 |
| `terminate [session]` | 세션 종료 |
| `restore [session]` | 세션 복원 |
| `new` | 새 세션 시작 |
| `renew [prompt]` | 세션 갱신 (프롬프트 유지 가능) |
| `context` | 컨텍스트 윈도우 상태 |
| `help` | 명령어 도움말 |

### Available Personas
`default`, `chaechae`, `linus`, `buddha`, `davinci`, `einstein`, `elon`, `feynman`, `jesus`, `newton`, `turing`, `vonneumann`

### Jira Mapping (scripts)
```bash
npm run mapping:list   # 매핑 목록
npm run mapping:sync   # Jira에서 동기화
npm run mapping:add    # 수동 추가
```

## Deployment

### Docker
```bash
docker-compose up -d          # Docker로 실행
docker-compose logs -f        # 로그 확인
```

### macOS LaunchAgent
```bash
./service.sh status|start|stop|restart|install|uninstall
./service.sh logs stderr 100    # 로그 확인
./service.sh logs follow        # 실시간 로그
```

### Service Config
- Name: `ai.2lab.soma-work.{main,dev}`
- Plist: `~/Library/LaunchAgents/ai.2lab.soma-work.{main,dev}.plist`
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
npx vitest       # 테스트 실행
```

### Project Structure
```
src/                    # 소스 코드
├── slack/              # Slack 관련 모듈 (SRP 분리)
│   ├── actions/        # 인터랙티브 액션 핸들러
│   ├── pipeline/       # 스트림 처리 파이프라인
│   ├── commands/       # 명령어 핸들러 (14개)
│   └── formatters/     # 포맷터 모듈
├── mcp/                # MCP 관련 모듈
├── github/             # GitHub 관련 모듈
├── permission/         # Permission 관련 모듈
├── prompt/             # 시스템 프롬프트 + 워크플로우
│   └── workflows/      # 워크플로우 프롬프트 (7개)
├── persona/            # 봇 페르소나 (12개)
└── local/              # Claude Code SDK 로컬 설정
    ├── agents/         # 에이전트 정의
    ├── commands/       # 커맨드 정의
    ├── prompts/        # 에이전트 페르소나
    └── skills/         # 스킬 정의
scripts/                # 유틸리티 스크립트
data/                   # 런타임 데이터 (auto-generated)
logs/                   # 로그 파일
docs/                   # 문서
├── spec/               # 상세 스펙 문서 (00~11)
├── issues/             # 이슈 트래킹 문서
├── architecture.md     # 아키텍처 개요
└── srp-refactoring-plan.md
```

### Key Config Files
```
mcp-servers.json            # MCP 서버 설정
mcp-servers.example.json    # MCP 서버 설정 예시
claude-code-settings.json   # Claude SDK 권한 설정
slack-app-manifest.json     # Slack 앱 매니페스트
slack-app-manifest.yaml     # Slack 앱 매니페스트 (YAML)
.system.prompt              # 루트 시스템 프롬프트
.system.prompt.example      # 시스템 프롬프트 예시
vitest.config.ts            # 테스트 설정
Dockerfile                  # Docker 이미지
docker-compose.yml          # Docker Compose 설정
```

### Git Push via gh CLI (multi-account)

기본 `GITHUB_TOKEN`이 bot 토큰이라 push 권한이 없을 때, `gh auth`에 등록된 다른 계정(예: `icedac`)의 토큰으로 push:

```bash
# 등록된 계정 확인
gh auth status

# 특정 계정의 토큰으로 push (GITHUB_TOKEN 환경변수가 있으면 gh auth switch 불가)
ICEDAC_TOKEN=$(gh auth token --user icedac)
git push "https://icedac:${ICEDAC_TOKEN}@github.com/OWNER/REPO.git" BRANCH_NAME
```

> `gh auth switch --user icedac`은 `GITHUB_TOKEN` 환경변수가 설정되어 있으면 동작하지 않음.
> URL에 토큰을 직접 임베딩하는 방식으로 우회.

### Key Design Decisions
1. **Facade Pattern**: 복잡한 서브시스템을 단순한 인터페이스로 제공
2. **Single Responsibility Principle**: 각 모듈이 하나의 책임만 담당
3. **Pipeline Architecture**: 입력 전처리 → 세션 초기화 → 스트림 실행
4. **Append-Only Messages**: 메시지 편집 대신 새 메시지 추가
5. **Session-Based Context**: 대화별 세션 유지
6. **Hierarchical CWD**: Thread > Channel > User 우선순위
7. **Real-Time Feedback**: 상태 리액션 + 라이브 태스크 업데이트
8. **Dependency Injection**: 테스트 용이성을 위한 의존성 주입
9. **Workflow Dispatch**: 입력 분류 → 전문 워크플로우 프롬프트 적용
