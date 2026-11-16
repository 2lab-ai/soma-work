# loop — code-changes 구현 드라이브

Status: in-progress (라운드 2 — dev 배포 · 실측) · 스펙 = [`../26-session-code-changes-spec.md`](../26-session-code-changes-spec.md) ·
아키텍처 = [`../27-session-code-changes-architecture.md`](../27-session-code-changes-architecture.md) · ssot = [`ssot.md`](ssot.md) ·
끝난 것 = [`loop.done.md`](loop.done.md)

## 라운드 2 — dev 배포 · 실측 (2026-11-16 열림)

계획: main(`d29a3fc6` 이후)을 dev에 배포 → 대시보드 변경점 탭 · `GET_SESSION` `session.codeChanges` · 고정 id 지표 행을 실서버에서 확인 → 번호 문서를 shipped로.

| ID | WU | Status | 이슈 | 막힌 것 | 끝상태 확인 |
|---|---|---|---|---|---|
| D1 | dev 배포 · 실측 | 🟡 | #1294 | 배포 prepare의 태그 push가 워크플로 토큰 403(2026-11-16 03:37 UTC부터) — 우회 PR #1307, 원인은 조직/저장소 Actions 설정(소유자) | 변경점 탭 스크린샷 · `session.codeChanges` · `merge_lines:` · `commit:` 행 |

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | 저장 문서의 정리(삭제) 정책 없음 — 대화 삭제 · 보관 기간 | 🚪 | 문서 하나 ≤ 6 MiB 상한만 있음. 대화 삭제와 같이 지우는 길을 정한다 |
| G2 | 세션 폴더 밖 체크아웃은 안 보인다 | 🚪 | 비목표(26 §2). 요청이 오면 재조정기와 같이 넓힌다 |
| G3 | 닫힌 세션의 PR이 닫힌 뒤 머지되면 머지 줄에 안 잡힌다 | 🚪 | PR 감시는 살아 있는 세션만 본다. 저장 문서를 도는 주기 확인이 필요하면 그때 |

## build facts (실측)

- 클론 직후: `npm ci` → `npm run build:packages` → `npm run build:somalib` → `npx vitest run <files>`.
- dashboard.ts를 import하는 라우트 테스트는 첫 변환이 ~30 s — 로컬은 `--hookTimeout 120000`.
- i18n: `npx tsx scripts/i18n/extract.ts --write` → `scripts/i18n/out/missing-page.json`을 main과 diff.
- CI quality-gates의 lint 범위는 `biome check src/ somalib/ scripts/ packages/` — 일부 폴더만 돌리면 포맷 오류를 놓친다.
