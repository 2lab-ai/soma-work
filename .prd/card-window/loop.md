# loop — card-window 구현 드라이브

Status: in-progress (라운드 1 — 구현 · 리시트 끝, 라이브러리 배포 대기) · 스펙 = [`../34-dashboard-task-card-window-controls-spec.md`](../34-dashboard-task-card-window-controls-spec.md) · ssot = [`ssot.md`](ssot.md)

## 라운드 1 — 계획 (2026-11-18)

| ID | 단위 | Status | 브랜치 · 워크트리 | 스코프 · 지금 |
|---|---|---|---|---|
| WU1 | 라이브러리 창 버튼 | 🟡 | `2lab-ai/ui` `feat/agent-inbox-window-controls` | `src/components/agent-inbox/{agent-inbox,styles,docs,agent-inbox.test}.ts`, 0.43.0. PR https://github.com/2lab-ai/ui/pull/84 — `npm run verify` 녹색(2,605), RED→GREEN 13 · 4 · 1. **머지됨 2026-11-18 `cc51d50`**, npm `@2lab.ai/ui@0.43.0` 배포됨(오너, shasum 679dce01, gitHead cc51d50) |
| WU2 | soma-work 연결 | 🟡 | `2lab-ai/soma-work` `feat/task-card-window-controls` | `dashboard.ts`(inboxPaint · wireInbox · openPanel · deckRemove · closePanel · closeDetailCard · 딥 링크 · 새 작업 카드 · autoOpenDecisions), 하네스 seam, 테스트 갱신. 대시보드 테스트 RED 15 → GREEN. PR https://github.com/2lab-ai/soma-work/pull/1349. `@2lab.ai/ui` 0.43.0 올림(package.json · lock) 뒤 대시보드 테스트 4,360 · 리시트 30/30(npm 배포본) |
| WU4 | SSOT_2 — 한 줄 TL;DR · 하루 지난 즐겨찾기 | 🟡 | WU1 · WU2와 같음 | 라이브러리 `.ib-min-tldr`(RED 1 → GREEN), soma-work `cardMinSeeds` · `cardStarDefaultFolded` · `soma-card-unfold`(RED 5 → GREEN). 스펙 D11 · D12 |
| WU3 | 실브라우저 리시트 | 🟡 | WU2와 같음 | `scripts/screenshot-card-window.ts` 30/30(스펙 §6 표 — 1440 보드 · 다크 감소된 모션 · 1280 목록 · 390 폰 · 즐겨찾기 TL;DR). 배포 뒤 dev에서 다시 |

## 리뷰 (2026-11-18, astra 1회) — 반영

P0 없음. P1 "0.43.0 배포 전 머지하면 상세 카드를 열 길이 없다" = G1(draft · 머지 금지 표시). P2 7건 반영: 한 줄 카드의 상태(점 + 낭독), 초기 접힘은 카드가 보드에 있는 동안 한 번, TL;DR × 뒤 포커스는 제목(라이브러리 3a96980); 새 결정이 사람이 접은 카드를 펼침, ‹ ›로 돌아온 카드를 다시 접지 않음(덱에 들어갈 때만), 다시 그려도 덱의 접힘 유지(필터 · CRON 레인), 상세 카드를 닫으면 제목으로 포커스(soma-work aae9c876).

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | `2lab-ai/ui`가 private이고 org 결제가 막혀 그 레포의 GitHub 호스트 러너가 돌지 않는다 — `v0.43.0` 태그 push로 npm 배포(`publish.yml`)가 안 된다(2026-11-18 실측: 실행이 2초 만에 "recent account payments have failed"). 이 머신에는 npm 로그인이 없다 | 🟡 | 2026-11-18 오너가 npm 배포(0.43.0, gitHead cc51d50) — soma-work 머지 · dev 실측이 남았다. 당시 2026-11-18 오너 작업 "@2lab.ai/ui 0.43.0을 npm에 배포 (main cc51d50)"로 요청(npm 로그인된 기기에서 깨끗한 클론 → 빌드 → `npm publish`). 레포 공개 전환은 하지 않는다(스트림 키트가 같은 레포). 배포되면 soma-work `@2lab.ai/ui` 0.43.0 올림 → ready → 머지 → dev 배포 → WU3를 dev에서 |
| G2 | `scripts/screenshot-detail-deck.ts`는 이 변경 전부터 깨져 있었다 — `#slide-panel.open`(지금은 `<ui-drawer open>`), "Stop" 버튼 글자(지금 "중지"), T6에서 없는 노드. 이번에 T2 흐름(면 → 제목 · ▽, `[open]`)만 새 계약으로 고쳤다 | 🔴 | 나머지는 그 리시트를 다시 쓸 때 |

## build facts (실측)

- soma-work 새 클론: `npm ci` → `npm run build:packages` → `npm run build:somalib` 뒤 `npx vitest run`.
- 대시보드 클라이언트 JS는 `renderDashboardPage` 템플릿 리터럴 안(ES5, 역슬래시 두 번). 테스트 하네스는 함수를 이름으로 잘라 불러온다 — 새 헬퍼는 `__fixtures__/viewer-scope.ts` `NEXT_ACTION_SEAMS`에 통과 seam을 두고, viewerScope를 쓰지 않는 로더는 `nextActionSeams(fns, inject)`를 합친다.
- 배포 전 로컬 확인: 라이브러리에서 `npm pack` → soma-work `node_modules/@2lab.ai/ui`를 그 압축본으로 바꿔 끼운다(저장소에 남기지 않는다).
- 리시트: `SOMA_CONFIG_DIR=$T/cfg SOMA_INSTANCE_DIR=$T/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-card-window.ts $T/out`.
- 라이브러리 게이트: `npm run verify`(biome · tsc · vitest · build:site · consumer-check).
