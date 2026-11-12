# loop — env-access 구현 드라이브

Status: in-progress (라운드 1 = 설계 문서 + 에픽) · AS-IS = [`../23-env-access-as-is.md`](../23-env-access-as-is.md) ·
TO-BE = [`../24-env-access-to-be.md`](../24-env-access-to-be.md) · 아키텍처 = [`../25-env-access-architecture.md`](../25-env-access-architecture.md) ·
ssot = [`ssot.md`](ssot.md)

## 라운드 1 — 설계 문서 · 에픽 · WU1 착수 (2026-11-12 열림)

계획: WU0(이 문서들)을 PR로 올린다 → 에픽 #1207과 서브이슈 #1208–#1214 (만듦, 2026-11-12) → WU1부터 PR 하나씩.

| ID | WU | Status | 이슈 | 브랜치 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|---|
| WU0 | 설계 문서 | 🟡 | #1208 | `docs/env-access-prd` | `.prd/23-25`, `.prd/env-access/` | PR 머지 |
| WU1 | 비밀 저장소 + 전원 거부 + fail-closed 샌드박스 | 🔴 | #1209 | — | 25 §5 WU1 | 25 §5 WU1 |
| WU2 | 어드민 샌드박스 프로필 + ssh는 MCP로만 | 🔴 | #1210 | — | 25 §5 WU2 | 25 §5 WU2 |
| WU3 | 환경 사용자 + 환경 도구 `gh` · `login` | 🔴 | #1211 | — | 25 §5 WU3 | 25 §5 WU3 |
| WU4 | 환경 grant + 4버튼 + 정책 단계 | 🔴 | #1212 | — | 25 §5 WU4 | 25 §5 WU4 |
| WU5 | 배포·QA 스킬 이전 + 배포 → QA 연결 | 🔴 | #1213 | — | 25 §5 WU5 | 25 §5 WU5 |
| WU6 | 브로커 제거 | 🔴 | #1214 | — | 25 §5 WU6 | 25 §5 WU6 |

## 열린 질문

| ID | 질문 | Status | 기본값 |
|---|---|---|---|
| Q1 | 컨테이너 배포처럼 샌드박스를 띄울 수 없는 호스트에서 `failIfUnavailable: true`를 어떻게 다룰지 | 🟡 | WU1에서 배포 대상 호스트별로 샌드박스 가능 여부를 실측하고, 불가한 곳은 배포 설정으로 명시적으로 끄게 한다(조용한 fail-open 금지) |
| Q2 | 고객 레포 배포 브랜치에 PR 승인 규칙을 걸지 (24 §6 남는 위험) | 🚪 | 어드민 결정 대기. 이번 스코프 밖 |

## 게이트 (build facts — WU1에서 실측해 갱신)

25 §6.

## 다음 착수점

WU0 PR 머지 → WU1(#1209) 브랜치 `feat/env-access-secrets`.
