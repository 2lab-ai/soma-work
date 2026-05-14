# soma-work

Slack에서 Claude Code SDK를 통해 AI 코딩 어시스턴트를 제공하는 TypeScript 봇.

## Slack Reference

- Slack UI/API/AI 앱 구현 기준 문서는 `docs/slack-block-kit.md`.
- Slack Block Kit payload 필드를 추가하거나 변경할 때는 `docs/slack-block-kit.md`의 제약과 공식 링크를 먼저 확인.

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
│   ├── actions/     # 인터랙티브 액션 핸들러 (8개)
│   ├── pipeline/    # 스트림 처리 파이프라인
│   ├── commands/    # 슬래시 명령어 핸들러 (16개)
│   ├── directives/  # 채널/세션 링크 디렉티브
│   └── formatters/  # 출력 포맷터
├── conversation/    # 대화 기록 및 리플레이
├── model-commands/  # 모델 커맨드 카탈로그 & 검증
├── mcp/             # MCP 서버 관리
├── github/          # GitHub App 인증 + Git 자격증명
├── permission/      # Slack 권한 프롬프트
├── prompt/          # 시스템 프롬프트 + 워크플로우 (9개)
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


whitelist 외 네이키드 텍스트는 채팅 / 워크플로우 디스패치로 처리.

**Migration (#506)**: whitelist 외의 legacy 네이키드 형태(`persona linus`, `model sonnet`, `show_prompt` 등)는 deprecated. 첫 사용 시 tombstone hint, 이후 drop. `SOMA_ENABLE_LEGACY_SLASH=true` 환경변수로 rollback 가능.
