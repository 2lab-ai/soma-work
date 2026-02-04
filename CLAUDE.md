# soma-work

Slack에서 Claude Code SDK를 통해 AI 코딩 어시스턴트를 제공하는 TypeScript 봇.

## Issue Tracking

`bd`로 태스크 관리. `bd ready`로 작업 확인, `bd update <id> --status in_progress`로 시작, `bd close <id> --reason "근거"`로 완료.
상세 규칙은 `.claude/rules/issuetracking.md` 참조.

## Architecture

**Facade Pattern** — 복잡한 서브시스템을 단순한 인터페이스로 제공:

| Facade | 역할 | 위임 대상 |
|--------|------|----------|
| `SlackHandler` | Slack 이벤트 처리 | `EventRouter`, `CommandRouter`, `StreamProcessor` |
| `ClaudeHandler` | Claude SDK 통합 | `SessionRegistry`, `PromptBuilder`, `McpConfigBuilder` |
| `McpManager` | MCP 서버 관리 | `ConfigLoader`, `ServerFactory`, `InfoFormatter` |

**Pipeline**: `InputProcessor` → `SessionInitializer` (dispatch + onboarding + channel routing) → `StreamExecutor`

### Module Layout

```
src/
├── slack/           # Slack 모듈 (SRP 분리)
│   ├── actions/     # 인터랙티브 액션 핸들러
│   ├── pipeline/    # 스트림 처리 파이프라인
│   ├── commands/    # 슬래시 명령어 핸들러 (14개)
│   └── formatters/  # 출력 포맷터
├── mcp/             # MCP 서버 관리
├── github/          # GitHub App 인증 + Git 자격증명
├── permission/      # Slack 권한 프롬프트
├── prompt/          # 시스템 프롬프트 + 워크플로우 (7개)
├── persona/         # 봇 페르소나 (12개)
└── local/           # Claude Code SDK 로컬 플러그인
```

## Design Decisions

1. **Facade Pattern**: 복잡한 서브시스템을 단순한 인터페이스로 제공
2. **Single Responsibility**: 각 모듈이 하나의 책임만 담당
3. **Pipeline Architecture**: 입력 전처리 → 세션 초기화 → 스트림 실행
4. **Append-Only Messages**: Slack 메시지 편집 대신 새 메시지 추가
5. **Session-Based Context**: 대화별 세션 유지
6. **Hierarchical CWD**: Thread > Channel > User 우선순위
7. **Workflow Dispatch**: 입력 분류 → 전문 워크플로우 프롬프트 적용
8. **Dependency Injection**: 테스트 용이성을 위한 의존성 주입

## Key Gotchas

- **듀얼 인스턴스 금지**: 같은 Slack 토큰으로 여러 인스턴스 실행 시 메시지 중복/충돌. 개발은 `npm start`만 사용.
- **고정 작업 디렉토리**: 각 유저별 `{BASE_DIRECTORY}/{userId}/` 고정. 유저가 직접 설정 불가 (보안 격리).
- **Git push multi-account**: `GITHUB_TOKEN`이 bot 토큰이라 push 불가 시:
  ```bash
  ICEDAC_TOKEN=$(gh auth token --user icedac)
  git push "https://icedac:${ICEDAC_TOKEN}@github.com/OWNER/REPO.git" BRANCH
  ```
- **Permission MCP Server**: `mcp-config-builder.ts`에서 `__filename` 기반 동적 확장자 사용 (.ts dev / .js prod). 하드코딩 금지.

## Slack Commands

| 명령 | 설명 |
|------|------|
| `cwd` | 현재 작업 디렉토리 |
| `mcp` / `mcp reload` | MCP 서버 목록 / 리로드 |
| `bypass [on/off]` | 권한 프롬프트 우회 |
| `persona [name]` | 페르소나 변경 |
| `model [name]` | 모델 변경 (sonnet/opus/haiku) |
| `sessions` | 활성 세션 목록 |
| `new` / `renew` | 세션 초기화 / 갱신 |
| `context` | 컨텍스트 윈도우 상태 |
| `restore` | 세션 복원 |
