# loop — code-changes 구현 드라이브

Status: in-progress (라운드 1) · 스펙 = [`../26-session-code-changes-spec.md`](../26-session-code-changes-spec.md) ·
아키텍처 = [`../27-session-code-changes-architecture.md`](../27-session-code-changes-architecture.md) · ssot = [`ssot.md`](ssot.md)

## 라운드 1 — 문서 · 에픽 · WU1 → WU3 → WU2 (2026-11-16 열림)

계획: 이 문서들을 WU1 PR에 싣는다 → 에픽 #1294 + 서브이슈 #1295–#1297 (만듦, 2026-11-16) → WU1(서버) 머지 → WU3(통계 · 모델)과 WU2(화면)를 WU1 위에서 → dev 배포 → 실측.

| ID | WU | Status | 이슈 | 브랜치 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|---|
| WU1 | 수집 · 저장 · 라우트 · 턴 끝 배선 · 요약 영속 | 🟡 | #1295 | `feat/code-changes-collector` (PR #1299 — 리뷰 2회 반영: 독립 리뷰 3건, Review of Legends P1 6건) | 27 §2–§6(라우트) | 27 §8 WU1 |
| WU2 | 변경점 탭 · 트리 · 전체 화면 뷰어 · i18n | 🟡 | #1296 | `feat/code-changes-tab` (커밋됨, WU1 머지 뒤 PR) | 27 §6(화면) | 27 §8 WU2 + 실서버 스크린샷 |
| WU3 | 통계(결정적 id · 파싱 제거 · PR 감시 재수집) · GET_SESSION · 턴 컨텍스트 | 🟡 | #1297 | `feat/code-changes-stats-model` | 27 §7 | 27 §8 WU3 + dev 지표 실측 |

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | 저장 문서의 정리(삭제) 정책 없음 — 대화 삭제 · 보관 기간 | 🚪 | WU1 뒤 결정. 문서 하나 ≤ 6 MiB 상한만 있음 |
| G2 | 세션 폴더 밖 체크아웃은 안 보인다 | 🚪 | 비목표(26 §2). 요청이 오면 재조정기와 같이 넓힌다 |
| G3 | 닫힌 세션의 PR이 닫힌 뒤 머지되면 머지 줄에 안 잡힌다 | 🚪 | PR 감시는 살아 있는 세션만 본다. 저장 문서를 도는 주기 확인이 필요하면 그때 |
| G4 | 경로 구성 요소를 심볼릭 링크로 바꿔치는 경쟁(검사 뒤 · git 호출 전) | 🚪 | 27 §5 남는 위험. 샌드박스의 다른 유저 폴더 읽기 공백(#732)과 같이 닫는다 |

## build facts (실측)

- 클론 직후: `npm ci` → `npm run build:packages` → `npm run build:somalib` → `npx vitest run <files>`.
- dashboard.ts를 import하는 라우트 테스트는 첫 변환이 ~30 s — 로컬은 `--hookTimeout 120000`.
- i18n: `npx tsx scripts/i18n/extract.ts --write` → `scripts/i18n/out/missing-page.json`을 main과 diff.
