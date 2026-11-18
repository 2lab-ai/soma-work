# loop — card-window 구현 드라이브

Status: 라운드 2 진행(SSOT_3 — 남의 작업 카드 기본 한 줄) · 라운드 1 닫힘(2026-11-18, [`loop.done.md`](loop.done.md) R1) · 스펙 = [`../34-dashboard-task-card-window-controls-spec.md`](../34-dashboard-task-card-window-controls-spec.md) D13 · ssot = [`ssot.md`](ssot.md)

## 라운드 2 — 계획 (2026-11-18, SSOT_3)

AS-IS(실측, main `0a2476cf`): 남의 카드도 내 카드와 같이 보통 크기로 그려진다(`cardMinSeeds`는 사람의 − 와 하루 지난 즐겨찾기만). `/auth/me`는 보드와 따로 오고, 요소는 한 번 본 카드의 시작 접힘을 다시 읽지 않는다(`@2lab.ai/ui` `#minSeen`) — 보는 사람을 늦게 알면 시드만으로는 접히지 않는다.

| ID | 단위 | Status | 브랜치 · 워크트리 | 스코프 · 끝상태 확인 |
|---|---|---|---|---|
| WU5 | 남의 카드 기본 한 줄 + 저장(D13) | 🟡 | `feat/card-window-others-fold` · `soma-work_20261118_card-window-others` | `dashboard.ts` `cardOthersDefaultFolded` · `cardMinSeeds` · `boardOwnerDefaults`(양쪽, 리뷰) · `_applyUserPill`, 시험 하네스 seam. 단위 RED → GREEN, 리시트 S15(시드 · + 저장 · 새로 고침 · − · 늦은 `/auth/me`) |
| WU7 | 앞 상세 카드만 한 줄(D7, SSOT_4) | 🟡 | `feat/card-window-front-only` · `soma-work_20261118_card-window-front` | `dashboard.ts` `boardSyncDetailFold` · `boardFoldDeck`(앞만) · `openPanel` · `closePanel` · `boardOwnerDefaults`(앞), 결정의 `_detailUnfolded` 제거. 덱 시험 갱신, 리시트 S5 · S6 · S13. #1355 리뷰 2회 시험 보강(저장된 − · 표시 모델 페이크 · 늦은 인증 + 상세 카드 · 계정 바뀜) |
| WU6 | dev 배포 · 배포 빌드 실측 | 🟡 | WU5 · WU7 머지 뒤 | dev 호스트 한 대 배포 → 배포 번들로 리시트 전부 |

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G2 | `scripts/screenshot-detail-deck.ts`는 이 변경 전부터 깨져 있었다 — `#slide-panel.open`(지금은 `<ui-drawer open>`), "Stop" 버튼 글자(지금 "중지"), T6에서 없는 노드. 라운드 1에서 T2 흐름(면 → 제목 · ▽, `[open]`)만 새 계약으로 고쳤다 | 🔴 | 나머지는 그 리시트를 다시 쓸 때 |

## build facts (실측)

- soma-work 새 클론: `npm ci` → `npm run build:packages` → `npm run build:somalib` 뒤 `npx vitest run`.
- 대시보드 클라이언트 JS는 `renderDashboardPage` 템플릿 리터럴 안(ES5, 역슬래시 두 번). 테스트 하네스는 함수를 이름으로 잘라 불러온다 — 새 헬퍼는 `__fixtures__/viewer-scope.ts` `NEXT_ACTION_SEAMS`에 통과 seam을 두고, viewerScope를 쓰지 않는 로더는 `nextActionSeams(fns, inject)`를 합친다. 시험 중 바뀌는 페이지 상태(패널 앞 카드)는 `load()`의 `prelude` · `exports`로 둔다.
- 배포 전 로컬 확인: 라이브러리에서 `npm pack` → soma-work `node_modules/@2lab.ai/ui`를 그 압축본으로 바꿔 끼운다(저장소에 남기지 않는다).
- 리시트: `SOMA_CONFIG_DIR=$T/cfg SOMA_INSTANCE_DIR=$T/inst CONVERSATION_VIEWER_TOKEN=t npx tsx scripts/screenshot-card-window.ts $T/out`. 배포 빌드를 잴 때(코드에 로더를 두면 lean-verify의 import 그래프가 문자열 아닌 로드로 실패한다 — #1354 실측):
  `W=$(mktemp -d); mkdir -p $W/scripts $W/src/conversation; cp scripts/screenshot-card-window.ts $W/scripts/; ln -s /opt/soma-work/dev/dist/conversation/web-server.js $W/src/conversation/web-server.js; ln -s $PWD/node_modules $W/node_modules; (cd $W && SOMA_CONFIG_DIR=… npx tsx scripts/screenshot-card-window.ts $T/out)` — Node가 링크를 따라가 번들의 모듈과 번들의 `@2lab.ai/ui`가 페이지를 낸다(보드 데이터는 브라우저 라우트라 배포의 저장본에 닿지 않는다). 잰 빌드는 `/opt/soma-work/dev/dist/version.json`.
- 라이브러리 게이트: `npm run verify`(biome · tsc · vitest · build:site · consumer-check).
- `@2lab.ai/ui` 배포: 레포가 private이고 org 결제가 막혀 `publish.yml`이 돌지 않는다(G1, R1). npm 로그인된 기기에서 오너가 `npm publish` — 오너 작업으로 요청한다.
