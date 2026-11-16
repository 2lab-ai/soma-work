# loop — issue-tree 구현 드라이브

Status: in-progress (라운드 1) · 스펙 = [`../29-session-issue-tree-spec.md`](../29-session-issue-tree-spec.md) · ssot = [`ssot.md`](ssot.md)

## 라운드 1 — WU1 · WU2 · WU3 (2026-11-16 열림)

계획: 리서치(끝남 — 링크 모델 · UPDATE_SESSION 경로 · 변경점 PR 수집 · GitHub 관계) → 29 스펙 → WU1(순수 모듈 TDD) → WU2(호스트 배선) · WU3(대시보드) → PR → 머지 → dev 배포 → 이 세션의 트리 실측(29 §8) → 29 shipped.

| ID | WU | Status | 브랜치 · 워크트리 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|
| WU1 | 트리 모델 · MCP 연산 | 🔴 | `feat/session-issue-tree` · `wt-tree` | `somalib/model-commands/`(types · issue-tree · validator · catalog · help), MCP 열거 | 29 §8 S1–S8(단위) |
| WU2 | 호스트 배선 | 🔴 | 같은 브랜치 | `session-registry` · `stream-executor` · `session-pr-reconciler` · `code-changes` · `link-metadata-fetcher` · `common.prompt` | 29 §8 S1–S8(통합) |
| WU3 | 변경점 탭 트리 | 🔴 | 같은 브랜치(또는 별 PR) | `dashboard.ts`(`KanbanSession`) · `code-changes-client.ts` · en-page | 29 §8 S9 · S10 |

## build facts (실측)

- 워크트리 `wt-tree`는 `wt-wu3/node_modules`를 심볼릭 링크로 쓴다(packages dist 포함).
- CI 린트 범위: `biome check src/ somalib/ scripts/ packages/`.
- 로컬 부하가 높으면 라우트 시험이 5초 타임아웃으로 떨어진다 — 단독 재실행으로 확인.
