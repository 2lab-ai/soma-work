# detail-card — done (append-only)

Loop: ./loop.md · Each round close appends one block at the bottom; nothing above it ever changes (the using-dotprd skill's `scripts/loop-lint.py` C2 compares against git). Rows here are snapshots (Last Measured frozen at move time). A later pass is a `re-verified` line in a loop.md round section; a regression reopens as a new loop.md row with Source `regression:<ID>`.

## R1 — closed 2026-11-16

- measured WU-A✅ WU-B✅ R1✅ · result: the tab bar is [작업 계획] | layout tabs | 사용자 작업, the 변경점 viewer has its panel and full-screen modes, and the review report is filed; dev v0.3.61 `1effc9c6` · closed rows: WU-A, WU-B, R1 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1313 (`effabad3`), https://github.com/2lab-ai/soma-work/pull/1311 (`1effc9c6`)

### Closed rows

| ID | Source | Universe Item | Observable Acceptance | AS-IS Evidence | Status | Gap | Dispatch | Verification Evidence | Last Measured |
|---|---|---|---|---|---|---|---|---|---|
| WU-A | ssot T10 · T15–T17 (SSOT_2 1, SSOT_3) | 탭 줄 양 끝: 작업 계획(맨 앞, 강조) · 사용자 작업(맨 끝, 대기 배지) | 28 §6 A1–A4 | 할 일 영역 1001,−27 439×460이 탭 줄 위에 늘 펼쳐짐, 대화 첫 탭 y 471 | ✅ | 탭 줄 두 줄(G2), 펼침 화살표 안 그려짐(G1, 기존) | PR #1311 (SSOT_3 재작업 + Review of Legends 9회) | dev v0.3.61: A1 첫 섹션 탭 y 227 · A2 순서 plan…useractions, `is-plan` accent · 650, 배지 1 · A3 영역 1001,226 439×461 ↔ 숨음 · A4 `data-midtab` plan, 계획 상자 439×84, 바 1017,749 407×50. 시험: detail-zones Z3–Z6, detail-bar-ends DOM 2(실시간 갱신 포함), agent-inbox openPanel 랜딩, needs-in-chat N8 2 — 변이 10개 확인. `src/conversation` 4,187 통과 | 2026-11-16 main `1effc9c6` |
| WU-B | ssot T11 · T12 (SSOT_2 2) | 변경점 뷰어: 카드 왼쪽 ≥ 640px면 패널(modal 아님), 아니면 전체 화면, 기억 · 자동 전환 | 28 §6 V1–V6 | 뷰어는 늘 modal 0,0 1440×900, 카드까지 덮음 | ✅ | — | PR #1313 | dev v0.3.61: V1 panel 0,56 1000×844 · V2 카드 트리 → 제목 전환, `.on` 1 · V3 Esc → 카드 남음 · V4 1024 full modal · V5 기억 · 패널로 · V6 1000 ↔ 1440 자동 전환, 페이지 오류 0. 시험 M1–M10(DOM) | 2026-11-16 main `1effc9c6` |
| R1 | ssot T13 | 여기까지 작업 리뷰 · 개선 리포트 | 리포트 + 개선 항목이 gap 행 | — | ✅ | — | 독립 리뷰어 1 + dev 실측 + 코드 대조 | [`../research/2026-11-16-code-changes-review.md`](../research/2026-11-16-code-changes-review.md) — F1–F9, 아이디어 5, 추천 라운드; 행 = `code-changes/loop.md` G6–G14, 이 루프 G1 · G2 | 2026-11-16 main `1effc9c6` |

### Round section (as it was in loop.md)

## 라운드 1 — WU-A · WU-B · 리뷰 리포트 (2026-11-16 열림)

계획: AS-IS 실측(28 §1, 끝남) → WU-A · WU-B를 서로소 파일로 나눠 TDD → PR 각각 → 머지 → dev 배포 → 하네스 좌표 실측(28 §6) → 리뷰 리포트(T13) → 28 shipped.

| ID | WU | Status | 브랜치 · 워크트리 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|
| WU-A | 탭 줄 [작업 계획] · … · 사용자 작업 (SSOT_3가 목표 탭 안 → 독립 탭으로 고침) | ✅ | `feat/detail-card-user-tasks-goal` · `wt-wu3` · PR #1311 머지 `1effc9c6` | `dashboard.ts`(마크업 · CSS · `panelBarTabIds` · `panelMidTabsOf` · `panelMidTabHtml` · `panelNeedsCount` · `renderPanelPlan` · `openPanel`), 시험 하네스 대역, en-page 카탈로그 | 28 §6 A1–A4 |
| WU-B | 변경점 뷰어 두 모드 | ✅ | `feat/changes-viewer-panel` · `wt-wu2` · PR #1313 머지 `effabad3` | `code-changes-client.ts`, `dashboard.ts`(`closePanel` · `syncPanelWidth`), 26 §4.2 | 28 §6 V1–V6 (dev v0.3.61 실측 끝, 28 §7) |
| R1 | 리뷰 리포트 | ✅ | — | 독립 리뷰어 + dev 실측 | Slack 리포트 · 개선 항목을 gap 행으로 |

결과: WU-B #1313(`effabad3`) → WU-A #1311(`1effc9c6`, SSOT_3로 재작업, 리뷰 9회) 머지 → dev v0.3.61 배포 → 배포 빌드로 28 §6 A1–A4 · V1–V6 실측 전부 통과(28 §7). 리뷰 리포트는 [`../research/2026-11-16-code-changes-review.md`](../research/2026-11-16-code-changes-review.md), 개선 항목은 `code-changes/loop.md` G6–G14와 이 루프의 G1 · G2로 옮겼다. 리뷰가 찾은 회귀 하나(답한 질문 뒤 빈 입력 필요 영역)는 #1311 안에서 고쳤다.
