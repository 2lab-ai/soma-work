# loop — issue-tree 구현 드라이브

Status: done (라운드 1 닫힘) · 열린 gap = G1–G4 · 스펙 = [`../29-session-issue-tree-spec.md`](../29-session-issue-tree-spec.md) · ssot = [`ssot.md`](ssot.md) · 끝난 것 = [`loop.done.md`](loop.done.md)

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | PR 상태는 읽기 순서를 따지지 않는다 — 관계는 `relReadAt`으로 줄 세우지만, 늦게 도착한 옛 읽기(느린 수집, 저장본을 다시 쓴 PR)의 `open`이 재조정기가 적은 `closed`를 덮을 수 있다(리뷰 12라운드 P2, PR #1321 스레드 4589990991) | 🔴 | 상태에도 읽기 시작 시각을 붙여 관계와 같은 규칙으로. 재오픈은 더 새 읽기로만 |
| G2 | 저장된 트리가 200개 꽉 찼는데 이슈가 하나도 없으면(PR만 200), 다시 맞출 때 시드가 201번째로 들어가 다음 불러오기에서 마지막 PR이 잘린다(리뷰 12라운드 P2, 스레드 4589991007) | 🔴 | 꽉 찬 루트 없는 트리: 시드를 넣기 전에 가장 오래된 호스트 자리 PR 하나를 빼거나, 불러오기에서 한 자리를 비운다 + 저장·불러오기 왕복 시험 |
| G3 | DOM 시험이 그려진 PR 줄을 눌러 그 PR의 파일만 보이는지 확인하지 않는다 — 지금 시험의 PR은 파일이 비어 있고 범위 id를 직접 준다(리뷰 12라운드 P2, 스레드 4589991015) | 🔴 | PR 둘에 서로 다른 파일을 주고, 중첩 · 스택 PR 줄을 실제로 눌러 그 PR 파일만 보이는지 |
| G4 | .prd/29 이전에 수집된 머지 PR의 저장본에는 `closes`가 없고, 머지 PR은 다시 읽지 않아서 수집이 그 관계를 끝내 모른다(설계대로 관계를 건드리지 않음). 이 세션의 #1299–#1301도 모델이 직접 옮겼다(29 §9 S10) | 🔴 | `closes`가 없는 머지 저장본은 파일은 그대로 두고 PR 상세만 한 번 다시 읽어 관계를 채운다 |

## build facts (실측)

- 워크트리는 `npm ci` + `npm run build:packages`를 직접(다른 워크트리 node_modules 심볼릭 링크 금지 — somalib가 엉뚱한 곳을 가리킨다).
- somalib는 제자리 컴파일: somalib을 고칠 때마다 `npm run build:somalib` 뒤에 시험(안 하면 vitest가 옛 `.js`를 읽는다).
- CI 린트 범위: `biome check src/ somalib/ scripts/ packages/`. tsc 대상은 es2021 — `Array.prototype.at` 금지.
- 로컬 부하가 높으면(평균 40–80) 훅 · 라우트 시험이 5–10초 타임아웃으로 떨어진다 — 단독 재실행으로 확인. `checkout-changes`의 1005파일 시험은 자체 60초 제한이라 부하 아래서 떨어진다(CI는 통과).
- 하네스: `scratch/e2e-tree-live.cjs` — 배포 빌드(`/opt/soma-work/dev/dist`) + 이 세션 저장본 사본, `env -i` + scratch `SOMA_CONFIG_DIR`.
