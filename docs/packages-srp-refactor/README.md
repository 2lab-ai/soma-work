# Packages × SRP Refactor

> Status: **Plan only** (no code changes). Author: 2026-05-11. **Revised 2026-05-12 (v2)** after codex hard review (42→target ≥95).
> 
> Sibling docs: [`plan.md`](./plan.md) · [`references.md`](./references.md)

## 한 줄 요약 (v2)

`src/` 88,550 LOC + `mcp-servers/` 8개 자식 프로세스 + `somalib/` 공유 워크스페이스를 **in-process 12 패키지 + child-process 8개 bin 패키지**로 분해한다. **deploy contract부터 먼저 고친다(Phase 0)** — Slack adapter는 그 다음.

> v1과 차이: v1은 `mcp-servers`를 단일 `@soma/mcp`로 흡수하고 Slack 카브아웃을 먼저 했다. codex 리뷰가 짚어낸 두 가지 실수 — (1) mcp-servers는 import 패키지가 아니라 **stdio 자식 프로세스**이므로 각자 `bin` 패키지여야 하고, (2) **3-way rsync 배포 fragility**가 안 풀린 상태에서 src/를 옮기면 마이그레이션 내내 운영 위험이 살아있다.

## Why now

| 신호 | 현재 비용 |
|---|---|
| `.github/workflows/deploy.yml`의 **3-way rsync drift** (dist/ + mcp-servers/ + somalib/ 각각 별도 rsync) | 한쪽 부분 실패 = MCP child process spawn crash. 사용자 표현 "deploy 가끔 병신처럼 됨"의 직접 원인. |
| `src/mcp-config-builder.ts:38`의 `path.resolve(__dirname, '..')/mcp-servers` | `dist/` 트리에서 `__dirname` 옮겨가면 즉시 ENOENT |
| `mcp-servers/_shared/`의 src 파일 8개 복사본 (PR #130 회귀 → `docs/mcp-server-independence` 의 band-aid) | src 변경 시 수동 sync. 한 번이라도 놓치면 child crash. |
| `src/session-registry.ts` 76KB, `token-manager.ts` 96KB, `slack-handler.ts` 60KB, `claude-handler.ts` 52KB | 한 파일 변경 = 전체 빌드 + 전체 테스트 |
| `src/` 루트에 30+ 파일이 평면 공존 | 새 entry 추가 시 어디 두는 게 옳은지 매번 재발견 |
| `@slack/bolt` import가 core(`claude-handler.ts`, `session-registry.ts`)에 leak | core 단독 테스트/재사용 불가 |
| `mcp-servers/`의 독립화 작업이 이미 3 트랙으로 진행 중 (`docs/mcp-refactor`, `docs/mcp-server-independence`, `docs/mcp-extraction`) | 같은 방향성을 한 우산(Phase 0) 아래로 합쳐야 함 |
| `somalib/` workspace는 cron + model-commands + permission + stderr-logger를 담고 있지만 **이름이 그 역할(cross-process shared)을 드러내지 않음** | proto-core가 아니라 **proto-process-shared**. v2는 `@soma/process-shared`로 승격. |

## What this doc is / is not

- **Is:** 12 in-proc + 8 child-proc bin 패키지 구조, DAG, 7-페이즈 마이그레이션(Phase 0 = deploy contract), §4 process boundary 인식, §5 deploy install contract(3-rsync→1-rsync), §7 임베디드 콘텐츠 asset 전략, depcruise 룰.
- **Is not:** 코드 변경. 이 PR은 docs only. 실제 이동은 페이즈별로 별도 PR로 나간다.

## TL;DR — first move (v2)

**[Phase 0 = deploy & MCP bin contract](./plan.md#phase-0--deploy--mcp-bin-contract-first--v1에서-빠졌던-페이즈)부터.** `packages/mcp-servers/<name>/` × 8 (각 `bin`) + `packages/process-shared/` 승격 + `mcp-config-builder`의 `require.resolve` 전환 + `deploy.yml` 3-rsync → 1-rsync + `smoke:deploy-bundle` CI gate. 운영 위험을 먼저 죽이고 그 다음에 src를 옮긴다. Slack 카브아웃은 Phase 2.

## Audit trail

- v1 결정: codex session `28e28a27-8b82-4bb5-844f-981279995453`
- v1 → v2 hard review: codex session `7b7e0b02-f189-4713-8d10-c4b6935a2c9b` (42/100 → 펀치리스트 7개 → v2 적용)
- gemini-cli 실제 소스(`packages/core`, `packages/cli`, `core/GEMINI.md`) 교차검증
- 트랜스크립트와 펀치리스트는 [`references.md`](./references.md).
