# References & Audit Trail

이 문서의 결정들이 어디서 왔는지 보이기 위함. 임의 의견이 아닌 근거 기반.

## 1. gemini-cli 실제 소스 — 핵심 증거 링크

| Claim in plan | Evidence |
|---|---|
| 7개 패키지 monorepo with npm workspaces | [`google-gemini/gemini-cli` packages dir](https://github.com/google-gemini/gemini-cli/tree/main/packages) — `a2a-server`, `cli`, `core`, `devtools`, `sdk`, `test-utils`, `vscode-ide-companion` |
| Root `package.json` workspaces 선언 | [`package.json` L7-9](https://github.com/google-gemini/gemini-cli/blob/main/package.json#L7-L9) — `"workspaces": ["packages/*"]` |
| core는 framework-agnostic, UI 의존 0 | [`packages/core/GEMINI.md`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/GEMINI.md) — "This package has no UI dependencies — keep it framework-agnostic." |
| core의 SRP 서브폴더 ≈ 27개 | [`packages/core/src/`](https://github.com/google-gemini/gemini-cli/tree/main/packages/core/src) — agent, agents, availability, billing, code_assist, commands, config, confirmation-bus, context, core, fallback, hooks, ide, mcp, output, policy, prompts, resources, routing, safety, sandbox, scheduler, services, skills, telemetry, tools, utils, voice |
| Sibling 패키지를 published name으로만 import | [`packages/cli/package.json` deps](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/package.json) — `"@google/gemini-cli-core": "file:../core"`. CLI 코드는 `@google/gemini-cli-core` import. |
| barrel 표면은 named export로 큐레이션 | [`packages/core/index.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/index.ts) — `export * from './src/index.js'` 외에는 `export { Storage } from ...`, `export { DEFAULT_GEMINI_MODEL, ... } from ...` 식으로 명시 선언 |
| ESLint로 cross-package 상대 import 제약 | gemini-cli CONTRIBUTING.md: "The project uses ESLint to enforce restrictions on relative imports between packages." |

## 2. soma-work 현재 상태 — 인용 가능한 사실

| Fact | Source |
|---|---|
| `src/` = 574 파일, 88,550 LOC | `find src -name "*.ts" \| wc -l` + `wc -l` 결과 (2026-05-11 main HEAD) |
| Hot files: `session-registry.ts` 76K, `token-manager.ts` 96K, `slack-handler.ts` 60K, `claude-handler.ts` 52K | `du -sh src/*` |
| 기존 workspace는 `somalib/` 단 하나 | 루트 `package.json` L23: `"workspaces": ["somalib"]` |
| `somalib/`는 `cron/`, `model-commands/`, `permission/`, `stderr-logger.ts` 보유 | `find somalib -name "*.ts"` |
| `mcp-servers/`는 workspace 아님, 별도 디렉토리 | 루트 `package.json`에 workspaces 등록 안 됨 |
| 기존 build가 `cp -r src/{prompt,persona,local,metrics/usage-render/assets} dist/`로 정적 에셋 옮김 | 루트 `package.json#scripts.build` |
| facade 분해가 이미 진행 중 (SlackHandler ~600 LOC, ClaudeHandler ~610 LOC, McpManager) | `docs/architecture.md` |
| MCP 분리 작업이 3 갈래로 동시 진행 중 | `docs/mcp-refactor/`, `docs/mcp-server-independence/`, `docs/mcp-extraction/` |

## 3. Codex consult — 결정 트랜스크립트

플랜의 §2 (target packages), §3 (DAG), §6 (lint enforcement), §7 (build pipeline)는 codex(`mcp__llm__chat`)와의 협의로 결정. autoz 규칙상 사용자 질의 없이 진행했으므로 audit trail을 남김.

### Round 1: Target package list

- Session: `28e28a27-8b82-4bb5-844f-981279995453` (codex / gpt-5.5)
- 결정: 9 + 1(test-utils) 패키지 구조. `@soma/common`, `extensions`, `integrations`, `mcp`, `metrics`, `core`, `sdk`, `slack`, `app`, `test-utils`.
- 첫 페이즈 결정: `@soma/slack` 카브아웃. 이유 — Slack surface는 이미 응집도 높음 → mechanical move 가능, @slack/bolt가 core에 leak되던 라인이 컴파일 에러로 폭로됨, 이후 페이즈의 의존 방향이 한 PR로 못박힘.
- 위 결정은 §1, §2, §4 Phase 1, §10에 반영.

### Round 2: Lint enforcement + build pipeline

- 같은 세션 resume.
- 결정 1 (lint): biome `noRestrictedImports`는 패키지 경계 그래프 룰에 부적합 — gitignore 스타일 specifier 패턴만 지원. **dependency-cruiser**를 채택. 이유 — resolved path matching + capture group + dependency-type 필터로 "형제 패키지의 src/를 상대경로로 import 금지" 룰 표현 가능.
- 결정 2 (build): 루트의 `cp -r src/... dist/...` 파이프라인 폐기. 각 패키지가 자기 `package.json#scripts.build`에서 자기 에셋을 자기 `dist/`로 emit. 루트 build는 `npm run build --workspaces`로 단순화.
- 위 결정은 §6, §7에 반영.

### Failed attempts (성실성 기록)

- 1차 큰 prompt(~900 단어 input, full A-G 결정 요청)는 codex 600s timeout. → 2차 codex prompt를 300단어로 축소했더니 성공.
- gemini fallback 시도는 "Backend returned empty session ID"로 실패.
- autoz 규칙: 5 retry strategy. 여기선 prompt 축소가 1번째 우회로 성공했으므로 다음 단계로 진행.

## 4. Why not these alternatives

| Alt | Why rejected |
|---|---|
| Nx / Turborepo로 monorepo 전환 | 의존 그래프 캐싱은 매력적이나, 현재 빌드는 단일 tsc + cp. 도구 도입 비용 > 이득. 워크스페이스만으로 충분. |
| Lerna | npm workspaces가 이미 동일 기능 제공. Lerna는 deprecated 신호 강함. |
| 모노레포 -> 멀티레포 (libsoma처럼 분리) | 동일 변경이 항상 두 레포에 걸침 (실제로 libsoma가 그렇게 운영됨). soma-work는 한 곳에 머무는 게 맞다. 패키지 분리만 하면 됨. |
| 패키지를 더 잘게 (~15개) | 각 패키지 overhead × 15 > 응집도 이득. 9개에서 시작, 운영하며 합칠 것은 합치고 쪼갤 것은 쪼갠다. |
| 패키지를 더 굵게 (3-4개) | `@slack/bolt`가 core에 새는 현재 문제를 해결 못 함. core / adapter 경계는 반드시 분리되어야 함. |
