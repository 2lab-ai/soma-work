# loop — code-changes 구현 드라이브

Status: done (라운드 1 · 2 닫힘 — 열린 gap G1–G3 · G5는 🚪) · 스펙 = [`../26-session-code-changes-spec.md`](../26-session-code-changes-spec.md) ·
아키텍처 = [`../27-session-code-changes-architecture.md`](../27-session-code-changes-architecture.md) · ssot = [`ssot.md`](ssot.md) ·
끝난 것 = [`loop.done.md`](loop.done.md)

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | 저장 문서의 정리(삭제) 정책 없음 — 대화 삭제 · 보관 기간 | 🚪 | 문서 하나 ≤ 6 MiB 상한만 있음. 대화 삭제와 같이 지우는 길을 정한다 |
| G2 | 세션 폴더 밖 체크아웃은 안 보인다 | 🚪 | 비목표(26 §2). 요청이 오면 재조정기와 같이 넓힌다 |
| G3 | 닫힌 세션의 PR이 닫힌 뒤 머지되면 머지 줄에 안 잡힌다 | 🚪 | PR 감시는 살아 있는 세션만 본다. 저장 문서를 도는 주기 확인이 필요하면 그때 |
| G5 | 카드의 지난 PR 칩이 머지 뒤에도 "열림"으로 남는다(dev 2026-11-16: #1299 · #1300 · #1301) — 변경점 탭은 "머지됨"으로 맞다 | 🚪 | 이 기능 밖: 세션 PR 감시(#928)는 현재 PR만 본다. 변경점 저장본의 PR 상태로 링크 기록을 고치거나 감시를 넓힌다 |

## build facts (실측)

- 클론 직후: `npm ci` → `npm run build:packages` → `npm run build:somalib` → `npx vitest run <files>`.
- dashboard.ts를 import하는 라우트 테스트는 첫 변환이 ~30 s — 로컬은 `--hookTimeout 120000`.
- i18n: `npx tsx scripts/i18n/extract.ts --write` → `scripts/i18n/out/missing-page.json`을 main과 diff.
- CI quality-gates의 lint 범위는 `biome check src/ somalib/ scripts/ packages/` — 일부 폴더만 돌리면 포맷 오류를 놓친다.
- dev 실측 화면: 배포 빌드(`/opt/soma-work/dev/dist`)를 scratch `SOMA_CONFIG_DIR` 아래에서 띄우고 dev 저장본(`code-changes/<대화 id>.json`)과 세션 줄을 복사해 넣는다 — 배포의 토큰 · 데이터는 읽기만 하고 쓰지 않는다. 카드 안 링크를 누르면 링크 뷰어가 열리니 카드 면은 포커스 + Enter로 연다.
- 호스트 부하가 높으면(load 40) git을 여러 번 부르는 시험이 기본 5초를 넘긴다 — 실패가 타임아웃인지 먼저 본다.
