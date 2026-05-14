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
| `src/` = 302 production TS files / 88,550 LOC, 579 TS files including tests | `find src -name "*.ts" ! -path "*/__tests__/*" ! -name "*.test.ts" \| wc -l`, matching `wc -l`; plus all-TS count (2026-05-12 current main after fetch/pull) |
| Hot files: `session-registry.ts` 76K, `token-manager.ts` 88K, `slack-handler.ts` 60K, `claude-handler.ts` 56K | `du -sh src/{session-registry,token-manager,slack-handler,claude-handler}.ts` |
| 기존 workspace는 `somalib/` 단 하나 | 루트 `package.json` L23: `"workspaces": ["somalib"]` |
| `somalib/`는 `cron/`, `model-commands/`, `permission/`, `stderr-logger.ts` 보유 | `find somalib -name "*.ts"` |
| `mcp-servers/`는 workspace 아님, 별도 디렉토리 | 루트 `package.json`에 workspaces 등록 안 됨 |
| 기존 build가 `cp -r src/{prompt,persona,local,metrics/usage-render/assets} dist/`로 정적 에셋 옮김 | 루트 `package.json#scripts.build` |
| 현재 TS 빌드는 CommonJS | root `tsconfig.json#compilerOptions.module = "commonjs"` |
| `mcp-tool-permission` MCP server가 부모 `src/`를 직접 import | `mcp-servers/mcp-tool-permission/mcp-tool-permission-mcp-server.ts` imports `../../src/mcp-tool-grant-store.js`, `../../src/mcp-tool-permission-config.js`, `../../src/admin-utils.js` |
| deploy workflow는 `service.sh`와 target-side `npm ci --omit=dev --no-audit --no-fund`도 배포 계약 일부 | `.github/workflows/deploy.yml` deploy step |
| facade 분해가 이미 진행 중 (SlackHandler ~600 LOC, ClaudeHandler ~610 LOC, McpManager) | `docs/architecture.md` |
| MCP 분리 작업이 3 갈래로 동시 진행 중 | `docs/mcp-refactor/`, `docs/mcp-server-independence/`, `docs/mcp-extraction/` |

## 3. Codex consult — 결정 트랜스크립트

플랜의 §2 (target packages), §3 (DAG), §9 (lint), §5 (deploy contract), §4 (process boundary)는 codex와의 협의로 결정. autoz 규칙상 사용자 질의 없이 진행했으므로 audit trail을 남김.

### Round 1 (v1 draft): Target package list

- Session: `28e28a27-8b82-4bb5-844f-981279995453` (codex / gpt-5.5)
- 결정: 9 + 1(test-utils) 패키지 구조 (이후 v2에서 보강됨).
- 첫 페이즈 결정 (v1): `@soma/slack` 카브아웃.

### Round 2 (v1 draft): Lint enforcement + build pipeline

- 같은 세션 resume.
- 결정 1 (lint): biome `noRestrictedImports`는 패키지 경계 그래프 룰에 부적합 — gitignore 스타일 specifier 패턴만 지원. **dependency-cruiser**를 채택.
- 결정 2 (build): 루트의 `cp -r src/... dist/...` 파이프라인 폐기. 각 패키지가 자기 `build`에서 자기 에셋을 자기 `dist/`로 emit.

### Round 3 (v2 hard review): 펀치리스트 7개

- Session: `7b7e0b02-f189-4713-8d10-c4b6935a2c9b` (codex / gpt-5.5, 2026-05-12)
- 입력: v1 plan + 사용자가 추가로 준 컨텍스트(mcp-servers는 stdio child process, deploy.yml의 3-rsync, somalib의 진짜 역할, src/local + src/prompt는 임베디드 콘텐츠).
- **점수: 42/100.** "decent generic src/ workspace split, but it misses the actual failure mode."
- 펀치리스트 (각 항목 v2 plan에 반영):

| # | Gap | v2 반영 위치 |
|---|---|---|
| 1 | "9 + 1" 숫자 목표화는 over-translation. 패키지 경계 = 실제 runtime 경계여야. | README.md "한 줄 요약 (v2)", plan.md §1 |
| 2 | `@soma/mcp` 단일 흡수는 틀림. mcp-servers는 import가 아니라 stdio 자식 프로세스. 각자 `bin` 패키지. | plan.md §1 (12 + 8 구조), §4 process boundary reality |
| 3 | `path.resolve(__dirname, '..')/mcp-servers` crash vector 유지됨. `require.resolve('@soma/mcp-server-*/bin/*')`로 교체 명시. | plan.md §4 마지막, §10 landmines, Phase 0 작업 #3 |
| 4 | somalib 흡수는 오분류. cross-process shared 패키지로 승격(`@soma/process-shared`), `_shared/` src-복사물 흡수. ESM/CJS dual emit. | plan.md §1, §2 (process-shared 행), §3 (양방향 화살표 노드), §10 landmines |
| 5 | Deploy fragility 미해결. `Deploy & install contract` 절을 Landmines 앞에 추가, 3-rsync → 1-rsync + `npm prune --omit=dev`. | plan.md §5 신설 |
| 6 | Asset 처리가 blunt. 패키지 안 `assets/` 루트 분리, exec bit 보존, smoke test. | plan.md §7 신설 |
| 7 | Phase 1 = Slack은 운영 리스크 무시. Phase 0 = deploy contract + MCP bin + process-shared가 먼저. | plan.md §6 reorder, §13 one-phase 권장 변경 |
| (보너스) | depcruise 룰에 "in-proc → mcp-server bin import 금지" + "mcp-server bin → in-proc 앱 internals import 금지" 추가. | plan.md §9 룰 3, 4 |

### Failed attempts (성실성 기록)

- v1 작업 시: 1차 codex large prompt(900 단어) 600s timeout → 2차 prompt 300단어로 축소해 성공. gemini fallback "Backend returned empty session ID" 실패.
- v2 hard review: 1회 만에 punch list 산출 성공.

### Round 4 (v3 hardening): current repo audit

- 입력: PR #871 v2 docs + current repo files (`package.json`, `tsconfig.json`, `src/mcp-config-builder.ts`, `.github/workflows/deploy.yml`, `service.sh`, `mcp-servers/*`, `somalib/*`).
- 추가 반영:

| # | Gap | v3 반영 위치 |
|---|---|---|
| 1 | target state가 12 in-proc이라고 쓰지만 실제 목록은 11 first-class packages | README, plan.md §1 |
| 2 | Phase 0에서 `mcp-tool-permission`의 `../../src/*` imports를 제거하지 않으면 bin 패키지화 직후 깨짐 | plan.md §2, §4, Phase 0, Landmines |
| 3 | 현재 root TS module은 CommonJS인데 v2 package example이 `type: "module"`을 섞음 | plan.md §4, §7, Landmines |
| 4 | `@soma/mcp-config`가 MCP bin packages를 resolve해야 하는데 depcruise rule이 모든 in-proc→mcp-bin edge를 금지 | plan.md §3, §9 |
| 5 | deploy YAML/package scripts에 inline shell과 escaped `node -e`가 많아 repo instruction의 escaping guardrail과 충돌 | README, plan.md §5, Phase 0, Landmines |
| 6 | bundle staging 예시는 `service.sh`/bootstrap script contract와 rsync filter-order risk를 충분히 다루지 않음 | plan.md §5 |

## 4. Why not these alternatives

| Alt | Why rejected |
|---|---|
| Nx / Turborepo로 monorepo 전환 | 의존 그래프 캐싱은 매력적이나, 현재 빌드는 단일 tsc + cp. 도구 도입 비용 > 이득. 워크스페이스만으로 충분. |
| Lerna | npm workspaces가 이미 동일 기능 제공. Lerna는 deprecated 신호 강함. |
| 모노레포 -> 멀티레포 (libsoma처럼 분리) | 동일 변경이 항상 두 레포에 걸침 (실제로 libsoma가 그렇게 운영됨). soma-work는 한 곳에 머무는 게 맞다. 패키지 분리만 하면 됨. |
| 패키지를 더 잘게 (~15개) | 각 패키지 overhead × 15 > 응집도 이득. 9개에서 시작, 운영하며 합칠 것은 합치고 쪼갤 것은 쪼갠다. |
| 패키지를 더 굵게 (3-4개) | `@slack/bolt`가 core에 새는 현재 문제를 해결 못 함. core / adapter 경계는 반드시 분리되어야 함. |
