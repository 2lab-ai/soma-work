# loop — detail-card 구현 드라이브

Status: in-progress (라운드 1) · 스펙 = [`../28-detail-card-user-tasks-and-viewer-panel-spec.md`](../28-detail-card-user-tasks-and-viewer-panel-spec.md) · ssot = [`ssot.md`](ssot.md)

## 라운드 1 — WU-A · WU-B · 리뷰 리포트 (2026-11-16 열림)

계획: AS-IS 실측(28 §1, 끝남) → WU-A · WU-B를 서로소 파일로 나눠 TDD → PR 각각 → 머지 → dev 배포 → 하네스 좌표 실측(28 §6) → 리뷰 리포트(T13) → 28 shipped.

| ID | WU | Status | 브랜치 · 워크트리 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|
| WU-A | 사용자 할 일 → 목표 탭 | 🟡 | `feat/detail-card-user-tasks-goal` · `wt-wu3` | `dashboard.ts`(마크업 · CSS · `panelMidTabsOf` · `renderPanelMidbar`), `view-layout-client.ts`(`detailSpecOf`), en-page 카탈로그 | 28 §6 A1–A4 |
| WU-B | 변경점 뷰어 두 모드 | 🟡 | `feat/changes-viewer-panel` · `wt-wu2` | `code-changes-client.ts`, `dashboard.ts`(`closePanel` · Esc · `ui-close`), 26 §4.2 | 28 §6 V1–V6 |
| R1 | 리뷰 리포트 | 🟡 | — | 독립 리뷰어 + dev 실측 | Slack 리포트 · 개선 항목을 gap 행으로 |

## build facts (실측)

- 워크트리: `npm run build:packages` 뒤 테스트(i18n이 packages/common dist를 읽는다).
- 하네스: `scratch/e2e-detail.cjs` — `SRC=<워크트리>`면 소스를 tsx로, 없으면 배포 빌드를 띄운다. `env -i` + scratch `SOMA_CONFIG_DIR`. 배포의 env-paths를 `env -i` 없이 불러오면 dev `.env`를 읽어 들인다.
- CI 린트 범위: `biome check src/ somalib/ scripts/ packages/`.
