---
name: using-z
description: "z / zcheck / ztrace / using-epic-issue 라우팅 결정표. 복수 phase vs 단일 PR 진입점 선택."
---

# using-z

z 컨트롤러 계열 스킬의 **진입점 선택 가이드**. 내부 로직은 각 스킬 파일이 소유.

## Roles

| 스킬 | 역할 | 호출 |
|---|---|---|
| `z` | 작업 컨트롤러 (phase 0~5). approve/CI 게이트 오너 | 유저 직접 `$z <URL>` |
| `zcheck` | post-impl CI + 리뷰 게이트 (approve 게이트 아님) | `z` phase3 자동 |
| `ztrace` | 시나리오별 콜스택 설명 | `z` phase4 자동 |
| `es` | 완료 공지 | `z` phase5 자동 |
| `using-epic-issue` | 에픽+서브이슈 규율 | 복수 phase 요청 시 |

## Decision Table

| 상황 | 진입 | 이유 |
|---|---|---|
| 복수 phase 피처 평문 요청 | `using-epic-issue` → `z` | 에픽 먼저, phase별 분해 |
| 기존 이슈/PR URL, 단일 PR | `z` | 컨트롤러 직행 |
| 에픽 서브이슈 URL | `z` | 서브이슈 = 단일 작업 단위 |
| "PR 체크해줘" (독립 CI+리뷰 게이트) | `zcheck` | post-impl 게이트만. approve ≠ 여기서 처리 |
| approve 직전 | `z` (phase4) | approve는 `z` 컨트롤러 소유. `zcheck` 직진 금지 |
| "이 PR 어떻게 작동?" | `ztrace` | 콜스택 단독 |
| 버그 리포트 | `z` (phase0.1 `stv:debug`) | debug 분기 |

## Invariants

진입 스킬 선택은 Decision Table을 따른다. approve/CI 게이트 규칙과 "1 서브이슈 = 1 PR" 같은 작업 단위 규율은 각 스킬이 소유 (여기서 복제 금지).
