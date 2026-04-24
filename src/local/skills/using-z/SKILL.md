---
name: using-z
description: "z / zcheck / ztrace / using-epic-tasks 라우팅 결정표 + 세션 핸드오프 프로토콜. 유저 요청이 들어오면 진입 스킬 하나를 고르고, phase 경계에서 CONTINUE_SESSION으로 세션을 갈아끼운다 — 내부 로직은 각 스킬 파일이 소유."
---

# using-z

z 컨트롤러 계열 스킬의 **진입점 선택 가이드 + 세션 핸드오프 프로토콜**. 내부 로직은 각 스킬 파일이 소유. 여기서는 "무엇을 먼저 부를지" + "phase 경계에서 세션을 어떻게 넘길지"만 결정.

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
| `<z-handoff type="plan-to-work">` sentinel 포함 prompt | `z` — phase0 step 0.5에서 감지 → phase2(zwork) 직행 | Handoff #1 결과. clarify/plan 재실행 금지 |
| `<z-handoff type="work-complete">` sentinel 포함 prompt | `z` — phase0 step 0.6에서 감지 → phase5.E(에픽 업데이트) 직행 | Handoff #2 결과. plan 단계 생략 |
| "PR 체크해줘" (독립 CI+리뷰 게이트) | `zcheck` | post-impl 게이트만. approve ≠ 여기서 처리 |
| approve 직전 | `z` (phase4) | approve는 `z` 컨트롤러 소유. `zcheck` 직진 금지 |
| "이 PR 어떻게 작동?" | `ztrace` | 콜스택 단독 |
| 버그 리포트 | `z` (phase0.1 `stv:debug`) | debug 분기 |

## Session Handoff Protocol

> **아래 규칙은 현재 prompt-level contract이며 host가 아직 강제하지 않는다.** 실제 host-side 강제는 §Enforcement Status 하단 에픽에서 구현 중. 이 섹션은 계약을 정의할 뿐이며, 위반 시 host가 막아주지 않는다 — 모델이 스스로 따라야 한다.

z 컨트롤러의 phase 전환 중 **세션 경계**를 넘는 것은 두 지점. `mcp__model-command__run`의 `CONTINUE_SESSION` 명령을 z 자신이 호출해서 새 세션으로 이전한다 — 유저가 "다음 이슈 새로 열어라"를 수동으로 하지 않아도 됨.

### Why session handoff

한 세션이 쌓는 컨텍스트 = {clarify 잡음 + 탐색 중 실패 경로 + 리뷰 피드백 + 구현 잡음}. 단계가 섞이면:

- zwork가 phase0 clarify 단계의 실패 경로를 끌고 다니며 캐시 drift
- 에픽 상위 view에 서브이슈 N개의 구현 잡음이 누적
- "다음 이슈 뭐였지?" 재구성 비용이 매 phase마다 발생

세션을 자르면 **계획은 계획대로, 구현은 구현대로, 에픽은 서브이슈 요약만** 보유 — 역할별 컨텍스트 격리.

### Handoff #1 — plan → work

**트리거**: z phase1에서 계획이 유저 Approve를 받고, 이슈 생성(또는 Case A escape의 tiny/small에서는 PR 스캐폴드 범위)까지 끝났을 때.

**선행 검증 (필수)**:

- Case A/B (medium 이상 포함 대부분): **Issue URL 존재**. 없으면 handoff 호출 금지, 유저에게 이유 출력 후 phase1로 돌아감.
- **Case A escape는 매우 제한적**으로만 유효: `using-epic-tasks`가 tier=`tiny`|`small`로 판정했고, 동시에 원 유저 요청에 "이슈부터 열어라" 같은 선행 이슈 요구가 없을 때만. 이 두 조건 모두 충족 시에만 escape 마커를 payload에 명시. 한 조건이라도 빠지면 escape 불가 → Issue URL 경로로만 진행.

이것이 "이슈 없이 PR" 우회 경로의 **구조적 차단선**. (현재는 prompt-level contract — host-side 강제는 §Enforcement Status 참고.)

**Payload**:

```json
{
  "commandId": "CONTINUE_SESSION",
  "params": {
    "prompt": "$z phase2 <ISSUE_URL or task-slug>\n\n<z-handoff type=\"plan-to-work\">\n## Issue\n<ISSUE_URL or \"none (Case A escape, tier=tiny|small)\">\n## Parent Epic\n<EPIC_URL or \"none\">\n## Confirmed Plan\n<plan markdown — Goal / Scope / Done>\n## Task List\n- [ ] task 1\n- [ ] task 2\n## Codex Review\nscore: <N>/100 — <verdict>\n</z-handoff>",
    "resetSession": true,
    "dispatchText": "<ISSUE_URL or task-slug>",
    "forceWorkflow": "default"
  }
}
```

**새 세션 z phase0 동작**:

1. prompt에서 `<z-handoff type="plan-to-work">` 탐지
2. clarify / new-task / codex 리뷰 단계 **스킵**
3. Task List를 TodoWrite로 등록
4. Issue URL + Parent Epic을 세션 전역 SSOT로 보관 (phase5에서 재사용)
5. phase2 (`local:zwork`) 직행

### Handoff #2 — work → epic (서브이슈인 경우만)

**트리거**:

1. zwork가 PR 머지까지 완료
2. z phase5 종료 직전
3. Handoff #1 payload의 `Parent Epic`이 `none`이 아님 (= 에픽의 서브이슈였음)

**Parent Epic이 `none`이면 Handoff #2 생략** — 단일 이슈 Case A는 phase5에서 `es` 호출 후 세션 종료.

**Payload**:

```json
{
  "commandId": "CONTINUE_SESSION",
  "params": {
    "prompt": "$z epic-update <EPIC_URL>\n\n<z-handoff type=\"work-complete\">\n## Completed Subissue\n<SUBISSUE_URL>\n## PR\n<PR_URL>\n## Summary\n<1-3줄 behavior 요약 — 무엇이 달성되었는지, 파일명/함수명 금지>\n## Remaining Epic Checklist\n- [x] 완료된 서브이슈 타이틀\n- [ ] 남은 서브이슈 타이틀 + URL\n</z-handoff>",
    "resetSession": true,
    "dispatchText": "<EPIC_URL>",
    "forceWorkflow": "default"
  }
}
```

**새 세션 z phase0 동작 (phase5.E branch)**:

1. prompt에서 `<z-handoff type="work-complete">` 탐지
2. clarify / plan 단계 **스킵**
3. 에픽 이슈에 Summary를 코멘트로 포스팅
4. 에픽 body Checklist 갱신 (`[ ]` → `[x]` 전환)
5. 하위 이슈 전부 closed + 체크리스트 전부 `[x]` → `using-epic-tasks/reference/github.md`(또는 `jira.md`)의 Epic Done 게이트 검증 후 에픽 close
6. 미완료 서브이슈 있으면 목록만 유저에게 출력. **자동으로 다음 서브이슈의 Handoff #1을 연쇄하지 않음** — 유저가 직접 `$z <next_subissue_url>` 입력하도록 유지.

### Protocol Rules (host enforcement pending)

1. **Handoff #1 선행조건 충족 전 호출 금지**. Case A/B는 Issue URL, Case A escape는 (tier=`tiny`|`small` ∧ 원요청에 선행 이슈 요구 없음) 두 조건 모두 충족 시 escape 마커. 둘 다 없으면 handoff 중단 + phase1 복귀.
2. `resetSession: true` 필수. 세션 컨텍스트 누적 금지.
3. **Handoff 예산 — 세션당 자동 1회**. 한 세션은 자동 handoff를 **최대 1회** 발행할 수 있다. 단, handoff로 시작된 **새 세션은 자신의 수명주기에서 다시 1회**를 발행할 수 있다 (phase2 구현 세션이 phase5에서 Handoff #2를 발행하는 것은 이 예산 안). 금지되는 것은: 한 세션 안에서 두 번 이상 발행, 또는 `work-complete` 수신 세션이 다음 서브이슈를 자동 체인으로 발행하는 것.
4. `<z-handoff>` sentinel 없는 prompt는 직접 유저 요청이므로 phase0부터 정상 진행.
5. `forceWorkflow: "default"` 사용. z는 workflow가 아닌 skill이므로 default 분류기가 `$z` prefix를 보고 z skill로 라우팅 (결정성 한계는 §Enforcement Status 참고).
6. payload의 `<z-handoff>` 블록 안에는 **구현 토큰(파일 경로, 함수명, ENV) 금지** — `using-ha-thinking` 규율. Summary / Plan은 behavior 레벨.

### Enforcement Status

현재 규율 수준과 목표:

| 항목 | 현재 강제 수단 | 목표 강제 수단 |
|---|---|---|
| Handoff #1 전 Issue URL 검증 | prompt convention (모델 규율) | `zwork` / PR 생성 경로 host-side guard |
| 결정적 새 세션 진입 | `$z` prefix + `default.prompt` 기대 | 전용 `WorkflowType` (`z-plan-to-work`, `z-epic-update`) |
| 1-hop 재귀 방지 | 문서 invariant | host-side `autoHandoffDepth` nonce |
| Dispatch 실패 복구 | default workflow 표류 | safe-stop + 유저 수동 retry 안내 |

**이 스킬 문서는 핸드오프 계약을 정의한다. host-side 강제 코드는 별도 에픽(Case B)에서 구현**. 모델이 이 문서를 따르면 의도대로 동작하지만, 현재 `default + $z` 경로에는 표류 가능성이 남아있음.

## Invariants (general)

1. 진입 스킬 선택은 **Decision Table**을 따른다.
2. `decision-gate` 호출은 **`z` phase0에서 1회만**. using-epic-tasks는 phase0이 전달한 tier를 신뢰 — 재호출 금지 (중복 방지).
3. approve/CI 게이트 규칙과 "1 서브이슈 = 1 PR" 같은 작업 단위 규율은 각 스킬이 소유 (여기서 복제 금지).
4. `using-epic-tasks`가 Case C 판정 시 `z`는 작업 시작 전 중단 후 유저 분해 승인 대기 (phase0.2).
5. Session handoff는 위 **Session Handoff Protocol**을 따른다. z / zwork는 해당 계약을 구현.
