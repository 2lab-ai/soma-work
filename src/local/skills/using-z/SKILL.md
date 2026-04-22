---
name: using-z
description: "z / zcheck / ztrace / using-epic-issue 스킬들의 최소 워크플로우와 선택 기준. 큰 피처 vs 단일 PR에 따른 엔트리포인트 결정 테이블 포함."
---

# using-z

z 컨트롤러 계열 스킬들의 **사용 가이드**. 언제 무엇을 쓰는가만 결정한다. 각 스킬의 내부 로직은 해당 스킬 파일이 소유.

## 스킬 역할 요약

| 스킬 | 역할 | 호출 주체 |
|---|---|---|
| `z` | 작업 컨트롤러. phase0~5 돌리며 분해·디스패치·리뷰·통합 | 유저가 직접 트리거 (`$z <이슈/PR/todo URL>`) |
| `zcheck` | 구현 후 게이트. CI + 리뷰 코멘트 0 + ztrace 설득 + approve 요청 | `z` phase3에서 자동 호출 |
| `ztrace` | PR 변경사항을 시나리오별 콜스택으로 설명 | `zcheck` Step 3 / `z` phase4에서 자동 호출 |
| `using-epic-issue` | 에픽 이슈 + 서브이슈 규율 | 유저가 복수 phase 요청 시 트리거 |

## Decision Table — 언제 무엇을

| 상황 | 진입 스킬 | 이유 |
|---|---|---|
| 유저가 "이거 해줘" 한 마디 + 복수 phase 냄새 | `using-epic-issue` → `z` | 에픽 먼저 만들고 phase별로 분해해야 추적 가능 |
| 유저가 기존 이슈/PR URL 제공, 단일 PR로 끝남 | `z` | 바로 컨트롤러 진입 |
| 유저가 에픽의 서브이슈 URL 제공 | `z` | 서브이슈 = 단일 작업 단위. 바로 `z` |
| 유저가 "PR 체크해줘" / "approve 직전 확인" | `zcheck` | 구현 끝난 상태의 게이트 |
| 유저가 "이 PR이 어떻게 작동해?" | `ztrace` | 콜스택 설명 단독 실행 |
| 버그 리포트 | `z` (phase0.1이 `stv:debug` 호출) | z가 debug 분기로 간다 |

## 최소 워크플로우 — 2가지 케이스

### Case A: 큰 피처 (multi-phase, multi-PR)

```
유저: "Slack UI 5블록으로 전환해줘"
  │
  ▼
[using-epic-issue Phase 1] 에픽 이슈 생성
  │   body = Goal + Checklist(서브이슈 링크) + Done-Done
  ▼
[using-epic-issue Phase 2] 서브이슈 N개 생성
  │   각 체크박스 = 1 서브이슈, 본문은 File Map/Test/Risk
  ▼
[using-epic-issue Phase 3] 체크박스 하나 선택 → $z <sub-URL>
  │
  ▼
[z phase0~5] 단일 PR 컨트롤러 실행
  │   phase0: SSOT/clarify/TodoWrite
  │   phase1: plan + codex ≥95 + UIAskUserQuestion 승인
  │   phase2: zwork (구현 + PR)
  │   phase3: zcheck (CI + 리뷰 + approve 요청)
  │   phase4: ztrace + approve
  │   phase5: es (완료 공지)
  ▼
PR merge → 서브이슈 자동 close
  │
  ▼
[using-epic-issue Phase 4] 에픽 체크박스 [x] 전환 (본문 다른 곳 건드리지 말 것)
  │
  ▼
다음 체크박스로 반복 → 모두 [x] 되면 에픽 close
```

### Case B: 단일 PR

```
유저: $z <이슈/todo/PR URL>
  │
  ▼
[z phase0~5] 그대로 실행
  │
  ▼
PR merge → 이슈 close → es 공지
```

## Anti-patterns

| ❌ 금지 | ✅ 대신 |
|---|---|
| 에픽 이슈에 바로 `z` 트리거 | 먼저 `using-epic-issue`로 서브이슈 생성 후 서브이슈에 `z` |
| 여러 phase를 한 PR에 섞기 | 서브이슈마다 PR 분리. `z`가 phase1에서 split 경고 |
| `zcheck` 생략하고 approve 요청 | `zcheck`의 Invariants가 체크함 — 우회 금지 |
| `ztrace` 없이 "잘 돌아요" 설득 | approve 요청에 ztrace 콜스택 첨부 필수 |
| 에픽 본문에 구현 로그 축적 | `using-epic-issue` Phase 4에서 차단. 로그는 서브이슈/PR |

## Invariants

1. **복수 phase ⇒ 에픽 필수.** `using-epic-issue` 없이 `z`로 바로 멀티 PR 시도 금지.
2. **서브이슈 없는 PR 금지** (큰 피처일 때). 예외: hotfix/typo.
3. **zcheck 통과 전 approve 요청 금지.** CI/리뷰/ztrace 누락 상태에서 유저에게 approve 물어보는 것은 스팸.
4. **ztrace 결과 첨부 없이 approve 요청 금지.** "merge해도 돼요?"는 근거 없이 물으면 안 된다.
5. **한 사이클(에픽 phase)에 한 PR.** 여러 서브이슈를 한 PR에 묶으면 롤백 단위가 깨진다.

## References

- 에픽 규율: `using-epic-issue/SKILL.md`
- 컨트롤러: `z/SKILL.md`
- 게이트: `zcheck/SKILL.md`
- 콜스택 설명: `ztrace/SKILL.md`
- 실패 사례(#525): 에픽 본문에 댓글 9개 축적 → 다음 작업 추적 불가. 이 스킬이 그 재발 방지.
