# loop — detail-card 구현 드라이브

Status: done (라운드 1 닫힘) · 열린 gap = G1 · G2 · 스펙 = [`../28-detail-card-user-tasks-and-viewer-panel-spec.md`](../28-detail-card-user-tasks-and-viewer-panel-spec.md) · ssot = [`ssot.md`](ssot.md) · 끝난 것 = [`loop.done.md`](loop.done.md)

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | 탭 줄의 펼침 화살표(`<i class="pm-caret" data-ui-icon="chevron-down">`)가 처음부터 그려지지 않는다 — `fillUiIcons`는 `data-ui-icon`이 먼저인 슬롯만 채운다(같은 꼴의 슬롯은 코드에 이것 하나). 리뷰 리포트 F9 | 🔴 | 속성 순서를 바꾼다. 화살표가 생기면 탭마다 폭이 늘어 G2와 같이 본다 |
| G2 | 440px 상세 카드에서 탭 줄이 두 줄이 된다(dev v0.3.61, 1440×900: y 154 · y 190 — 사용자 작업이 둘째 줄) | 🚪 | 탭 수가 많은 레이아웃만. 좁을 때 숫자만 남기거나 가로 스크롤로 한 줄 — 요청이 오면 |

## build facts (실측)

- 워크트리: `npm run build:packages` 뒤 테스트(i18n이 packages/common dist를 읽는다).
- 하네스: `scratch/e2e-detail.cjs` — `SRC=<워크트리>`면 소스를 tsx로, 없으면 배포 빌드를 띄운다. `env -i` + scratch `SOMA_CONFIG_DIR`. 배포의 env-paths를 `env -i` 없이 불러오면 dev `.env`를 읽어 들인다.
- CI 린트 범위: `biome check src/ somalib/ scripts/ packages/`.
