---
name: using-z
description: "z / zcheck / ztrace / using-epic-tasks 라우팅 결정표. 유저 요청이 들어오면 진입 스킬 하나를 고르는 thin router — 내부 로직은 각 스킬 파일이 소유."
---

# using-z

z 컨트롤러 계열 스킬의 **진입점 선택 가이드**. 내부 로직은 각 스킬 파일이 소유. 여기서는 "무엇을 먼저 부를지"만 결정.

## Roles

| 스킬 | 역할 | 호출 |
|---|---|---|
| `z` | 작업 컨트롤러 (phase 0~5). phase0에서 `decision-gate` 호출 → tier 확정 → using-epic-tasks 위임. approve/CI 게이트 오너 | 유저 직접 `$z <URL>` |
| `zcheck` | post-impl CI + 리뷰 게이트 (approve 게이트 아님) | `z` phase3 자동 |
| `ztrace` | 시나리오별 콜스택 설명 | `z` phase4 자동 |
| `es` | 완료 공지 | `z` phase5 자동 |
| `using-epic-tasks` | tier 받아 Case A/B/C 라우팅 (이슈·에픽·서브이슈 구조 규율) | `z` phase0/phase1 자동 |
| `using-ha-thinking` | 각 산출물 본문의 층 규율 | using-epic-tasks에서 자동 참조 |
| `decision-gate` | tier 판정. 유저 질문 vs 자율 판단 gate | `z` phase0 자동 |

## Decision Table

| 상황 | 진입 | 이유 |
|---|---|---|
| 새 구현 요청 (평문, URL 없음) | `z` → phase0 decision-gate → tier → using-epic-tasks Case A/B/C | 모든 구현 요청의 단일 진입점. tier가 분기 결정 |
| 기존 이슈/PR URL | `z` | 컨트롤러 직행. 이미 이슈·PR 있으면 Case A/B 구조는 고정 |
| 에픽 서브이슈 URL | `z` | 서브이슈 = 단일 작업 단위 |
| "PR 체크해줘" (독립 CI+리뷰 게이트) | `zcheck` | post-impl 게이트만. approve ≠ 여기서 처리 |
| approve 직전 | `z` (phase4) | approve는 `z` 컨트롤러 소유. `zcheck` 직진 금지 |
| "이 PR 어떻게 작동?" | `ztrace` | 콜스택 단독 |
| 버그 리포트 | `z` (phase0.1 `stv:debug`) | debug 분기 |

## Invariants

1. 진입 스킬 선택은 **Decision Table**을 따른다.
2. `decision-gate` 호출은 **`z` phase0에서 1회만**. using-epic-tasks는 phase0이 전달한 tier를 신뢰 — 재호출 금지 (중복 방지).
3. approve/CI 게이트 규칙과 "1 서브이슈 = 1 PR" 같은 작업 단위 규율은 각 스킬이 소유 (여기서 복제 금지).
4. `using-epic-tasks`가 Case C 판정 시 `z`는 작업 시작 전 중단 후 유저 분해 승인 대기 (phase0.2).
