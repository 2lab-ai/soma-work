# loop — issue-tree 구현 드라이브

Status: done (라운드 1 · 2 닫힘, 열린 gap 없음) · 스펙 = [`../29-session-issue-tree-spec.md`](../29-session-issue-tree-spec.md) · ssot = [`ssot.md`](ssot.md) · 끝난 것 = [`loop.done.md`](loop.done.md)

## 열린 gap

없음 — G1–G4는 라운드 2에서 닫혔다(PR #1324, [`loop.done.md`](loop.done.md) R2).

## build facts (실측)

- 워크트리는 `npm ci` + `npm run build:packages`를 직접(다른 워크트리 node_modules 심볼릭 링크 금지 — somalib가 엉뚱한 곳을 가리킨다).
- somalib는 제자리 컴파일: somalib을 고칠 때마다 `npm run build:somalib` 뒤에 시험(안 하면 vitest가 옛 `.js`를 읽는다).
- CI 린트 범위: `biome check src/ somalib/ scripts/ packages/`. tsc 대상은 es2021 — `Array.prototype.at` 금지.
- 로컬 부하가 높으면(평균 40–80) 훅 · 라우트 시험이 5–10초 타임아웃으로 떨어진다 — 단독 재실행으로 확인. `checkout-changes`의 1005파일 시험은 자체 60초 제한이라 부하 아래서 떨어진다(CI는 통과).
- 하네스: `scratch/e2e-tree-live.cjs` — 배포 빌드(`/opt/soma-work/dev/dist`) + 이 세션 저장본 사본, `env -i` + scratch `SOMA_CONFIG_DIR`.
