# loop — secret-access 구현 드라이브

Status: in-progress (라운드 1 열림 2026-11-18) · ssot = [`ssot.md`](ssot.md) · 스펙 = [`../32-secret-access-spec.md`](../32-secret-access-spec.md) ·
아키텍처 = [`../33-secret-access-architecture.md`](../33-secret-access-architecture.md)

## 라운드 1 — 문서 · 에픽 · WU1부터

계획: WU0(이 문서들) PR → 에픽 #1335 + 서브이슈 #1336–#1340 (만듦, 2026-11-18) → WU1 → WU2 · WU3 → WU4(dev 배포 · 실측). WU 하나 = 브랜치 하나 = PR 하나.

| ID | WU | Status | 이슈 | 브랜치 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|---|
| WU0 | 설계 문서 | 🟡 PR #1341 (CI 녹색, 리뷰 대기) | #1336 | `docs/secret-access-prd` | `.prd/32` · `33` · `secret-access/` | PR 머지 |
| WU1 | 비밀 관리자 + 감사 원장 + 비밀 탭(목록 · 추가 · 덮어쓰기 · 삭제) | 🟡 PR #1342 (CI 녹색, 리뷰 대기) | #1337 | `feat/secret-access-store-tab` | 33 §7 WU1 | 32 A7 · A8 · A9 |
| WU2 | 비밀 grant + 판정 ③ + 3버튼 카드 + 비밀 탭 권한 편집 | 🟡 PR #1343 (CI 녹색, #1342 위에 쌓임) | #1338 | `feat/secret-access-grants` | 33 §7 WU2 | 32 A1–A6 |
| WU3 | 서버 도구 탭 + 카탈로그 + config.json 수준 쓰기 | 🟡 PR #1345 (#1343 위에 쌓임) | #1339 | `feat/secret-access-server-tools-tab` | 33 §7 WU3 | 32 A10 · A11 |
| WU4 | dev 배포 + 실측 + 문서 shipped | 🔴 | #1340 | — | 33 §7 WU4 | 32 A12 |

## 열린 질문

| ID | 질문 | Status | 기본값 (이대로 진행) |
|---|---|---|---|
| Q1 | 승인자가 어드민인가, 요청한 유저 자신인가 (SSOT_1 "유저별로 저장"의 읽기) | 🟡 | 어드민(32 D1). 비밀은 어드민 관리 대상이고 SSOT_2의 권한 편집도 어드민 |
| Q2 | 어드민 전용 도구를 비밀 허락으로 열어도 되나 | 🟡 | 연다(32 D6) — 도구 조건표는 유지, 카드에 경고. 막으려면 ③에서 어드민 전용 도구를 빼는 한 줄 |
| Q3 | 환경 × 도구 칸 권한이 필요한가 (SSOT_2 "각각의 api나 환경 등") | 🟡 | 도구별 · 환경별 따로(지금 권한 모델 두 축). 칸 권한은 새 SSOT |

## 게이트 (build facts)

33 §8.

## 라운드 1 결과 (2026-11-18)

- WU1–WU3 구현 · 테스트 · 문서 끝, PR로 쌓임: #1342(main) ← #1343 ← #1345. 각 PR 본문 첫 절에 calldiff.
- WU3 증거: 라우트 7 · 탭 11 · 카탈로그 계약 · permission-map 8 테스트, 만진 스위트 226/226, `npm run build` 0, 브라우저(모의 API) 관리자 · 표 없음 · 읽기 전용 · 비어드민(탭 안 보임) 확인.
- 전체 `vitest run` 22520 통과. 실패 1건 `src/a2t/__tests__/a2t-available-memory`는 호스트 메모리를 읽는 기존 실패(`src/a2t` main과 동일).

## 다음 착수점

리뷰 · 머지 순서: #1341 → #1342 → #1343 → #1345(아래 PR이 머지되면 위 PR의 base를 main으로 바꾼다). 그다음 WU4(#1340): dev 배포(`$user:dev`, 로컬 dev 호스트만 — 고객 환경 금지) 후 32 A12 실측.
