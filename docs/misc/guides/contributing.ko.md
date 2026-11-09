# soma-work 개발

## 문서

- 현재 아키텍처, 스펙, trace, archive, 문서 라우팅 규칙은 [docs map](../../../docs/README.md)에서 시작합니다.
- 장기 유지할 결정은 [ADR index](../../../docs/adr/README.md)에 정리합니다.
- 완료/아카이브된 작업은 [completed work ledger](../../../docs/archive/completed-work.md)에서 추적합니다.
- AI agent 친화적인 프로젝트 문서 정리 리서치는 [docs/research](../../../docs/misc/research/2026-05-18-ai-agent-docs-organization.md)에 있습니다.
- Slack Block Kit/API 제약은 [docs/misc/reference/slack-block-kit.md](../../../docs/misc/reference/slack-block-kit.md)에 유지합니다.

## 프로젝트 구조

> 숫자 카운트는 반드시 drift합니다 — 디렉토리를 직접 확인하세요. 전체 컴포넌트 와이어링: [docs/misc/reference/architecture.md](../../../docs/misc/reference/architecture.md)

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
│   └── z/                          # /z 명령어 surface + 비-admin DM 입력 게이트
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
├── local-harness/                  # soma-work 전용 플러그인 `local` (하네스 스킬: auto-es)
└── local/                          # Claude Code SDK 확장 (플러그인 `zworkflow`, 범용 — skills/, agents/, hooks/)

packages/                           # 워크스페이스 패키지
├── mcp-servers/                    # 내장 MCP 서버 (agent, cron, model-command, devops-tools, ...)
├── devops-broker/                  # 별도 OS 유저 브로커: gh 토큰 + Cloudflare forge 키 보관, 자체 Slack 앱으로 admin 승인
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

## 테스트

```bash
npx vitest run          # 단일 실행
npx vitest              # 감시 모드
```

테스트 커버리지: 이벤트 라우팅, 스트림 처리, 명령어 파싱, 권한 검증, 도구 포맷팅, 세션 관리, 액션 핸들러, 파이프라인 처리, MCP 통합, 멀티 에이전트 라이프사이클 등.
