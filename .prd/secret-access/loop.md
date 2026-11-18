# loop — secret-access 구현 드라이브

Status: in-progress (라운드 1 열림 2026-11-18) · ssot = [`ssot.md`](ssot.md) · 스펙 = [`../32-secret-access-spec.md`](../32-secret-access-spec.md) ·
아키텍처 = [`../33-secret-access-architecture.md`](../33-secret-access-architecture.md)

## 라운드 1 — 문서 · 에픽 · WU1부터

계획: WU0(이 문서들) PR → 에픽 + 서브이슈 → WU1 → WU2 · WU3 → WU4(dev 배포 · 실측). WU 하나 = 브랜치 하나 = PR 하나.

| ID | WU | Status | 이슈 | 브랜치 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|---|
| WU0 | 설계 문서 | 🟡 | — | `docs/secret-access-prd` | `.prd/32` · `33` · `secret-access/` | PR 머지 |
| WU1 | 비밀 관리자 + 감사 원장 + 비밀 탭(목록 · 추가 · 덮어쓰기 · 삭제) | 🔴 | — | — | 33 §7 WU1 | 32 A7 · A8 · A9 |
| WU2 | 비밀 grant + 판정 ③ + 3버튼 카드 + 비밀 탭 권한 편집 | 🔴 | — | — | 33 §7 WU2 | 32 A1–A6 |
| WU3 | 서버 도구 탭 + 카탈로그 + config.json 수준 쓰기 | 🔴 | — | — | 33 §7 WU3 | 32 A10 · A11 |
| WU4 | dev 배포 + 실측 + 문서 shipped | 🔴 | — | — | 33 §7 WU4 | 32 A12 |

## 열린 질문

| ID | 질문 | Status | 기본값 (이대로 진행) |
|---|---|---|---|
| Q1 | 승인자가 어드민인가, 요청한 유저 자신인가 (SSOT_1 "유저별로 저장"의 읽기) | 🟡 | 어드민(32 D1). 비밀은 어드민 관리 대상이고 SSOT_2의 권한 편집도 어드민 |
| Q2 | 어드민 전용 도구를 비밀 허락으로 열어도 되나 | 🟡 | 연다(32 D6) — 도구 조건표는 유지, 카드에 경고. 막으려면 ③에서 어드민 전용 도구를 빼는 한 줄 |
| Q3 | 환경 × 도구 칸 권한이 필요한가 (SSOT_2 "각각의 api나 환경 등") | 🟡 | 도구별 · 환경별 따로(지금 권한 모델 두 축). 칸 권한은 새 SSOT |

## 게이트 (build facts)

33 §8.

## 다음 착수점

WU0 PR → 에픽 · 서브이슈 → WU1 브랜치 `feat/secret-access-store-tab`.
