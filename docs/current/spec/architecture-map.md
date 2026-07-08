# soma-work 아키텍처 맵 (구조화)

> 2026-06-27 생성. 실제 코드(HEAD 69f572ff)를 스캔해 만든 무손실 구조 맵.
> CLAUDE.md의 "Module Layout"은 `src/`만 기술하고 `packages/`를 누락한 **stale 상태** — 이 문서가 현행 SSOT.
> 구조 = 런타임 의존 레이어(트리) + **횡단 관심사(매트릭스)**. 횡단 부분은 트리가 아니라 그래프이므로 매트릭스로 정직하게 표시한다.

**한 줄 결론:** soma-work는 "Slack → Claude Code SDK 에이전트 호스트"다. 모듈 레이어는 깔끔하게 계층적이지만, **config·permission·persistence·packaging 횡단 관심사가 `src`/`packages`/`somalib` 세 트리에 중복·분산되어 있는 것**이 이 repo의 지배적 구조 부채다.

---

## A. 런타임 의존 레이어 (트리)

> 레이아웃 정본은 `docs/misc/reference/architecture.md` + CLAUDE.md Module Layout이다. 아래 트리는 §B(횡단 부채)를 읽기 위한 최소 골격일 뿐 — 여기서 레이아웃을 관리하지 않는다(카운트·전체 목록은 정본을 따른다).

```
soma-work (Slack ⇄ Claude Code SDK 에이전트 호스트)
│
├─ [0] 진입/호스트
│   ├─ src/index.ts ─ 부트스트랩 (crash-recovery, resumeActiveGoals)
│   ├─ src/slack-handler.ts ─ Facade: Slack 이벤트 → EventRouter/CommandRouter/StreamProcessor
│   └─ src/claude-handler.ts ─ Facade(1433줄): SDK 통합 · 세션 · 크레덴셜 · 훅 · 권한정책 (← 아직 미분해, ADR 0002 pass2+)
│
├─ [1] Slack I/O  (src/slack/* + @soma/slack)
│   ├─ commands/ (16) · actions/ (8) · pipeline/ (StreamExecutor) · directives/ · formatters/
│   └─ goal-*.ts ─ 멀티-goal 큐 / 루프 컨트롤러 / 회계   ※ @soma/slack 와 src/slack 이 양분
│
├─ [2] 에이전트 런타임 seam  (src/agent-runtime/)   ← ADR 0002
│   ├─ agent-runner.ts (port, SDK import 금지) · claude-code-runner.ts (유일한 SDK 어댑터)
│   ├─ runner.ts (dispatcher) · index.ts (runOneShotText)
│   └─ policy/ ─ permission-mode · tool-policy · safety-classifier(+factory)   ◆ 권한 결정의 일부만 여기
│
├─ [3] 도메인/서비스  (src/*)
│   ├─ conversation/ · model-commands/ · prompt/ (9) · persona/ (12)
│   ├─ github/ (App auth) · mcp/ · plugin/ (zworkflow 번들) · cct-store/ · metrics/
│   └─ hooks/ ─ bypass-permission-guard · hook-policy · hook-state   ◆ 권한 결정의 또 다른 일부
│
├─ [4] 공유 라이브러리  (workspaces)
│   ├─ @soma/common ─ env-paths(진짜) · 기반 유틸
│   ├─ @soma/process-shared ─ permission/ · *-store · mcp-tool-* · env-paths(분기된 사본!)
│   ├─ @soma/test-utils ─ mock-slack-api · mock-session · mock-claude-handler
│   └─ somalib/ ─ ⚠ packages/ 밖 top-level 변칙 · process-shared의 re-export shim 타깃 + cron
│
├─ [5] MCP 서버  (packages/mcp-servers/*)
│   ├─ llm/ (codex/gemini 라우팅) · permission/ ─┐  ⚠ 권한 MCP 서버가 둘
│   └─ mcp-tool-permission/ ───────────────────┘
│
└─ [6] 배포/운영
    ├─ scripts/deploy/ (stage-bundle · sync-bundle) · scripts/service.sh (headless fallback)
    └─ .github/workflows/deploy.yml · deploy/protected-paths.txt
```

범례: `◆` = 횡단 관심사가 여기에도 흩어져 있음 · `⚠` = 구조 변칙 · `※` = 이중 출처.

---

## B. 횡단 관심사 매트릭스 (← 이 repo의 진짜 부채)

각 관심사는 "한 곳"이어야 하는데, 실제로는 세 트리에 흩어져 있다. **숫자는 전부 실측.**

| 관심사 | 이상(SSOT) | 실제 분산 (증거) | 룰 |
|---|---|---|---|
| **Config / env** | 타입드 accessor 1개 | `env-paths`가 셋(`src`=re-export ✓, `@soma/common`=정본, `@soma/process-shared`=**분기된 사본**) · `config.ts`는 preflight/parseBool만 · `process.env.*` 직접 읽기가 도메인 전반에 산재 · `BASE_DIRECTORY` vs `SOMA_BASE_DIRECTORY` 이름충돌 · `../../../config` 상대경로 스파게티 | [config.md](../../../rules/config.md) |
| **Permission / 인가** | 결정 파이프라인 1개 | `agent-runtime/policy/*` + `hooks/{bypass-permission-guard,hook-policy}` + `slack/{bypass-topic,bypass-handler}` + action handler들 + **MCP 권한서버 둘** + `process-shared/permission/*` + grant store 이중(`src`·`process-shared`) + `click-classifier` 이중 | [permission.md](../../../rules/permission.md) |
| **Persistence** | 원자적 store 헬퍼 1개 | `writeFileSync`가 여러 곳, 전부 비원자적 · `memory-file-store`·`skill-file-store`·`shared-store`·`pending-*-store`가 `src`/`somalib`/`process-shared` 삼중복 · 로드 실패 시 조용히 빈값(데이터 전손) | [config.md](../../../rules/config.md) (저장 절) |
| **Package 경계** | 코드는 `@soma/*`에 한 번만 | `src`가 여전히 다수, `packages`로 이관 진행 중 · 내용-동일 사본 다수 + 분기 사본(env-paths) + somalib 삼중복 · `somalib` 가 packages 밖 · `packages/extensions` 는 `dist/`만 잔존(소스 삭제됨) | [packaging.md](../../../rules/packaging.md) |

> 정확한 현재 수치(사본·writeFileSync·env 읽기 등)는 각 룰의 **§검증** rg 명령으로 라이브 산출한다 — 이 문서엔 태리를 박지 않는다(drift 방지).

---

## C. 미배치 단위 (노이즈 아님 — 후속 과제로 명시)

- **`claude-handler.ts` 1433줄**: credentials·hooks·MCP·permission이 한 파일에 엉킴. ADR 0002가 pass2+로 명시 연기. 권한/런타임 룰의 최종 수렴점.
- **`config.json` / `mcp-servers.json` / `.system.prompt` / `.env`**: 파일 기반 설정. env-paths가 경로를 풀지만 스키마 검증·타입은 없음.
- **`data/*.json` 런타임 산출물**: sessions·user-settings·grants·requests·hook-state — 위 29 store가 쓰는 대상. 원자성·백업 부재.

이 3개는 버릴 노이즈가 아니라, 룰이 수렴시켜야 할 타깃이다.
