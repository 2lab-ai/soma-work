---
name: using-z
description: "z / zcheck / ztrace / using-epic-issue 라우팅 결정표 및 최소 워크플로우. 복수 phase vs 단일 PR 진입점 선택."
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

## Workflows

### Case A — 멀티 phase 피처

```
유저 요청
  ▼
[using-epic-issue P1] 에픽 생성 (body = index)
[using-epic-issue P2] 서브이슈 N개
  ▼
[반복] P3: 체크박스 1개 → $z <sub-URL>
         ▼
       [z phase 0~5] 단일 PR 완결
         ▼
       P4: 체크박스 [x]
  ▼
전 [x] → Done-Done 검증 → 에픽 close
```

### Case B — 단일 PR

```
$z <URL> → z phase 0~5 → merge → es 공지
```

## Invariants

1. 복수 phase ⇒ 에픽 필수. `using-epic-issue` 우회 multi-PR 금지.
2. **1 서브이슈 = 1 PR.** 에픽은 여러 서브이슈/PR의 인덱스이며 직접 구현 단위가 아님.
3. 진입 스킬 선택은 Decision Table을 따름. approve/CI 게이트 규칙은 각 스킬이 소유 (여기서 복제 금지).

## Anti-patterns

| ❌ | ✅ |
|---|---|
| 에픽 URL에 바로 `z` | `using-epic-issue`로 서브이슈 분해 후 서브이슈 URL에 `z` |
| 여러 서브이슈를 1 PR에 묶기 | 서브이슈마다 PR 분리 (롤백 단위) |
| 라우팅 결정 없이 임의 진입 | Decision Table 확인 후 진입 |

## References

- `using-epic-issue/SKILL.md` — 에픽 규율
- `using-epic-issue/reference/github.md` — GitHub 문법
- `using-epic-issue/reference/jira.md` — Jira 문법
- `z/SKILL.md` · `zcheck/SKILL.md` · `ztrace/SKILL.md` · `es/SKILL.md`
