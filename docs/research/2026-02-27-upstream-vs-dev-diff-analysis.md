# 2lab-ai/soma-work (dev) vs mpociot/claude-code-slack-bot (main) 비교 분석

> **Source**: https://github.com/mpociot/claude-code-slack-bot/compare/main...2lab-ai:soma-work:dev
> **Date**: 2026-02-27
> **Commits**: 316개 (ahead)
> **변경 파일**: 300개 (신규 283 / 수정 17)
> **주요 변경**: +22,616 / -1,518 lines

---

## 1. Upstream (mpociot/main) 원본 구조

단일 커밋의 초기 프로젝트. 약 13개 소스 파일로 구성된 모놀리식 구조.

### 핵심 파일

| 파일 | 라인 | 역할 |
|------|------|------|
| `slack-handler.ts` | 785 | Slack 이벤트 처리 (모놀리식) |
| `claude-handler.ts` | 145 | Claude Code SDK `query()` 래핑 |
| `working-directory-manager.ts` | 176 | 채널/스레드별 CWD 관리 |
| `todo-manager.ts` | 141 | TodoWrite 도구 → Slack 메시지 |
| `file-handler.ts` | - | 파일 업로드 처리 |
| `image-handler.ts` | 48 | 이미지 base64 변환 |
| `mcp-manager.ts` | - | MCP 서버 설정 로드 |
| `permission-mcp-server.ts` | - | 권한 승인 MCP 서버 |
| `config.ts` | 30 | 환경변수 설정 |
| `logger.ts` | - | 로깅 |
| `types.ts` | 16 | 타입 정의 |

### Upstream 의존성

```
@anthropic-ai/claude-code: ^1.0.35
@modelcontextprotocol/sdk: ^1.13.2
@slack/bolt: ^4.4.0
dotenv: ^16.6.0
node-fetch: ^3.3.2
```

### Upstream 주요 기능

1. **Slack DM + 멘션 메시지 처리**: 직접 메시지와 @멘션으로 Claude에 질문
2. **스레드 기반 세션**: 스레드별 세션 유지, `sessionId` 기반 resume
3. **Working Directory 관리**: 채널/스레드별 CWD 설정 (`cwd` 명령)
4. **파일 업로드 처리**: Slack 파일 다운로드 → 프롬프트에 첨부
5. **이미지 핸들링**: 이미지 파일 base64 변환
6. **MCP 서버 연동**: `mcp-servers.json` 기반 MCP 서버 설정
7. **도구 권한 시스템**: Slack 버튼으로 도구 실행 승인/거부
8. **TodoWrite 표시**: Claude의 TodoWrite 도구 출력을 Slack 메시지로 표시
9. **리액션 이모지 상태**: 🤔→⚙️→✅/❌ 리액션으로 진행 상태 표시
10. **도구 사용 포맷팅**: Edit/Write/Read/Bash 도구별 Slack 포맷 메시지

---

## 2. 우리 서비스 (dev) 주요 확장

### 2.1 아키텍처 (Facade + Pipeline + SRP)

**Upstream**: `slack-handler.ts` 785줄 모놀리식
**우리**: Facade → Router → Pipeline 패턴

| 모듈 | 파일 수 | 역할 |
|------|---------|------|
| `slack/commands/` | 16 | 슬래시 명령어 핸들러 (SRP) |
| `slack/actions/` | 8 | 인터랙티브 액션 핸들러 |
| `slack/pipeline/` | 4 | 입력 → 세션 → 스트림 파이프라인 |
| `slack/formatters/` | 2 | Markdown→Block Kit 변환 |
| `slack/directives/` | 2 | 채널/세션 링크 디렉티브 |
| `mcp/` | 3 | MCP 서버 관리 (Factory 패턴) |
| `permission/` | 3 | 권한 서비스 분리 |
| `model-commands/` | 4 | 모델 커맨드 카탈로그 |
| `conversation/` | 6 | 대화 기록 + 요약 |
| `github/` | 4 | GitHub App 인증 |

### 2.2 Claude Agent SDK 마이그레이션

- `@anthropic-ai/claude-code` (query) → `@anthropic-ai/claude-agent-sdk` (SDK 0.2+)
- Agent SDK의 세션 관리, 스트리밍, 도구 결과 처리 활용
- `session-registry.ts`: 세션 레지스트리 패턴으로 세션 생명주기 관리

### 2.3 Prompt / Workflow 시스템

9개 전문 워크플로우 프롬프트:

| 워크플로우 | 파일 | 용도 |
|-----------|------|------|
| default | `default.prompt` | 기본 코딩 어시스턴트 |
| dispatch | `dispatch.prompt` | 입력 분류 → 워크플로우 라우팅 |
| onboarding | `onboarding.prompt` | 유저 온보딩 |
| pr-review | `pr-review.prompt` | PR 코드 리뷰 |
| pr-fix-and-update | `pr-fix-and-update.prompt` | PR 수정 후 업데이트 |
| pr-docs-confluence | `pr-docs-confluence.prompt` | PR → Confluence 문서 |
| jira-planning | `jira-planning.prompt` | Jira 이슈 계획 |
| jira-brainstorming | `jira-brainstorming.prompt` | Jira 브레인스토밍 |
| jira-executive-summary | `jira-executive-summary.prompt` | 경영진 요약 |
| deploy | `deploy.prompt` | 배포 워크플로우 |

### 2.4 페르소나 시스템

12개 커스텀 페르소나 (`src/persona/`):

`default`, `einstein`, `feynman`, `linus`, `turing`, `vonneumann`, `newton`, `davinci`, `elon`, `buddha`, `jesus`, `chaechae`

### 2.5 슬래시 명령어 확장

Upstream 3개 → 우리 16개:

| 명령 | Upstream | 우리 | 설명 |
|------|----------|------|------|
| `cwd` | ✅ | ✅ | 작업 디렉토리 |
| `mcp` | ✅ | ✅ | MCP 서버 관리 |
| `mcp reload` | ✅ | ✅ | MCP 리로드 |
| `bypass` | ❌ | ✅ | 권한 우회 토글 |
| `persona` | ❌ | ✅ | 페르소나 변경 |
| `model` | ❌ | ✅ | 모델 선택 |
| `sessions` | ❌ | ✅ | 활성 세션 목록 |
| `new` | ❌ | ✅ | 세션 초기화 |
| `renew` | ❌ | ✅ | 세션 갱신 |
| `close` | ❌ | ✅ | 세션 종료 |
| `context` | ❌ | ✅ | 컨텍스트 윈도우 상태 |
| `restore` | ❌ | ✅ | 세션 복원 |
| `link` | ❌ | ✅ | 이슈/PR 링크 첨부 |
| `onboarding` | ❌ | ✅ | 온보딩 실행 |
| `verbosity` | ❌ | ✅ | 출력 상세도 |
| `help` | ❌ | ✅ | 도움말 |

### 2.6 인프라 / DevOps

- **CI/CD**: GitHub Actions 자동 배포 (`dev`/`main` 브랜치)
- **Docker**: Dockerfile + docker-compose
- **macOS LaunchDaemon**: `service.sh` 서비스 관리
- **Setup Wizard**: 12단계 설치 스크립트
- **Healthcheck**: `healthcheck.js`

### 2.7 GitHub App 인증

- `github/api-client.ts`: GitHub App → Installation Token 발급
- `github/git-credentials-manager.ts`: Git credential helper
- `github/token-refresh-scheduler.ts`: 토큰 자동 갱신

### 2.8 보안

- `dangerous-command-filter.ts`: 위험 명령어 필터
- `credential-alert.ts`: 크레덴셜 노출 감지
- `credentials-manager.ts`: 크레덴셜 관리

### 2.9 테스트

- 49개 테스트 파일 (upstream: 0개)
- Mock 팩토리: `mock-slack-api.ts`, `mock-claude-handler.ts`, `mock-session.ts`
- Vitest 프레임워크

### 2.10 기타

- `channel-registry.ts`: 채널별 설정 레지스트리
- `channel-description-cache.ts`: 채널 설명 캐시
- `claude-usage.ts`: 사용량 추적
- `mcp-call-tracker.ts`: MCP 호출 통계
- `link-metadata-fetcher.ts`: URL 메타데이터 추출
- `release-notifier.ts`: 릴리스 알림
- `shared-store.ts`: 공유 상태 저장소
- `dispatch-service.ts`: 입력 분류 서비스
- `context-window-manager.ts`: 컨텍스트 윈도우 관리

---

## 3. Upstream에는 있지만 우리가 재구현/변경한 것

| Upstream 기능 | 우리의 구현 | 차이 |
|--------------|------------|------|
| `query()` 기반 SDK | Agent SDK 0.2+ | 더 풍부한 세션 관리 |
| 모놀리식 `slack-handler.ts` | Facade + Pipeline | SRP 분리 |
| `working-directory-manager.ts` | `channel-registry.ts` + `cwd-handler.ts` | 채널 레지스트리 통합 |
| `todo-manager.ts` | 유지 (동일) | - |
| `image-handler.ts` | 유지 (동일) | - |
| `permission-mcp-server.ts` | `permission/` 모듈 분리 | 서비스 분리 |
| 도구 포맷팅 (inline) | `message-formatter.ts` + `markdown-to-blocks.ts` | Block Kit 변환 |
| 리액션 이모지 상태 | `assistant-status-manager.ts` | 전용 매니저 분리 |

---

## 4. 적용 가능한 피쳐 리스트

### 🔴 HIGH — 즉시 적용 가치

#### F1. TodoWrite 도구 Slack 표시 개선
- **Upstream**: TodoWrite 도구 호출 시 Slack에 진행률 메시지 실시간 업데이트
- **현황**: 우리도 `todo-manager.ts`가 있지만, 파이프라인에서 TodoWrite 이벤트를 Slack 메시지로 업데이트하는 통합이 약할 수 있음
- **가치**: 사용자에게 Claude 작업 진행 상황을 실시간으로 보여줌
- **작업량**: ★★☆ (stream-executor에 TodoWrite 이벤트 핸들러 추가)

#### F2. 도구 사용 포맷팅 강화
- **Upstream**: Edit → diff 형태, Bash → code block, Read → 파일명만 등 도구별 포맷
- **현황**: `message-formatter.ts`에서 이미 일부 구현, 하지만 upstream의 diff 표시가 더 직관적
- **가치**: 사용자가 Claude가 뭘 하는지 한눈에 파악
- **작업량**: ★☆☆ (포맷터 개선)

#### F3. 채널 입장 시 자동 Welcome 메시지
- **Upstream**: `member_joined_channel` 이벤트 → 채널 설정 안내
- **현황**: 우리에게 `onboarding-handler.ts`가 있지만, 자동 입장 감지는 미확인
- **가치**: 신규 채널 설정 가이드 자동화
- **작업량**: ★☆☆ (이벤트 핸들러 추가)

### 🟡 MEDIUM — 점진적 적용

#### F4. 요청 취소 (AbortController) UX
- **Upstream**: 같은 세션에서 새 메시지 입력 시 이전 요청 자동 취소 + ⏹️ 리액션
- **현황**: 파이프라인에서 AbortController 지원 여부 확인 필요
- **가치**: 사용자가 잘못된 요청을 바로 취소 가능
- **작업량**: ★★☆

#### F5. Base Directory 기반 상대 경로 CWD
- **Upstream**: `BASE_DIRECTORY` 환경변수로 `cwd project-name` → `/base/project-name` 자동 resolve
- **현황**: 우리는 유저별 고정 디렉토리 (`{BASE_DIRECTORY}/{userId}/`) 사용
- **가치**: 유연한 프로젝트 전환 (우리 모델과 다르므로 참고만)
- **작업량**: N/A (아키텍처 차이)

#### F6. 세션 자동 정리 (Cleanup Inactive Sessions)
- **Upstream**: 5분 주기로 30분 이상 비활성 세션 자동 정리
- **현황**: `session-registry.ts`에서 관리 중이나 자동 정리 주기 확인 필요
- **가치**: 메모리 누수 방지
- **작업량**: ★☆☆

### 🟢 LOW — 참고/영감

#### F7. Image Handler 통합
- **Upstream**: `image-handler.ts`로 이미지 업로드 → base64 변환 → 분석
- **현황**: 파일이 존재하지만 파이프라인 통합 여부 확인 필요
- **가치**: 스크린샷/다이어그램 기반 코딩 지원
- **작업량**: ★★☆

#### F8. `file_share` 서브타입 별도 이벤트 처리
- **Upstream**: `message` 이벤트에서 `file_share` 서브타입을 별도로 캐치
- **현황**: 파이프라인의 `input-processor.ts`에서 처리 여부 확인
- **가치**: 파일 전용 플로우 안정성
- **작업량**: ★☆☆

---

## 5. 다른 Fork에서 참고할만한 피쳐 (교차 참조)

| 피쳐 | Fork | 우리 상태 | 우선순위 |
|------|------|----------|---------|
| CLI Process Spawning | kkhfiles | Agent SDK 사용 중 | N/A |
| 세션 영속화 (.json) | kkhfiles | 미구현 (메모리 only) | 🔴 HIGH |
| CWD 영속화 (.json) | kkhfiles | `channel-registry.ts` 확인 필요 | 🟡 MEDIUM |
| Multi-Agent (채널 내 복수 에이전트) | ZoeFridler | 미구현 | 🟡 MEDIUM |
| Agent Template 시스템 | ZoeFridler | 미구현 | 🟢 LOW |
| Quiet Mode (도구 메시지 숨김) | ZoeFridler | `verbosity` 명령으로 유사 | ✅ 있음 |
| `@agent-name` 라우팅 | ZoeFridler | 미구현 | 🟡 MEDIUM |

---

## 6. 통계 요약

| 항목 | Upstream | 우리 (dev) |
|------|----------|-----------|
| 소스 파일 (src/) | 13 | 180+ |
| 테스트 파일 | 0 | 49 |
| 의존성 패키지 | 6 | 11 |
| 슬래시 명령어 | 3 | 16 |
| 페르소나 | 0 | 12 |
| 워크플로우 프롬프트 | 0 | 9 |
| Slack 액션 핸들러 | 2 | 8 |
| MCP 서버 통합 | 기본 | Factory 패턴 |
| CI/CD | ❌ | GitHub Actions |
| Docker | ❌ | ✅ |
| 문서 (docs/) | README만 | spec 10개 + architecture + plans |
