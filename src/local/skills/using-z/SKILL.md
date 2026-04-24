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

> **아래 규칙은 prompt-side 계약이며, 일부는 host가 추가로 강제한다.** 어느 항목이 host로 강제되는지는 §Enforcement Status 표 참고 — 본문은 계약만 정의한다.

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
- **Case A escape는 매우 제한적**으로만 유효 — **세 조건 모두 충족** 시에만:
  (a) `using-epic-tasks` tier=`tiny`|`small`,
  (b) 원 유저 요청에 "이슈부터 열어라" / "이슈 먼저 만들어줘" / "issue도 남기고" 같은 **명시적·암시적** 선행 이슈 요구가 없음,
  (c) 레포지토리 정책(`CONTRIBUTING.md`·팀 규율·브랜치 보호 룰·PR 템플릿 등)이 "모든 PR은 연결 이슈 필수"를 **요구하지 않음**.
  한 조건이라도 빠지면 escape 불가 → Issue URL 경로로만 진행. 특히 (c)는 레포가 이슈 정책을 강제하면 유저가 말을 안 해도 escape 차단 — 유저 요청만 보고 판단하지 말 것.

이것이 "이슈 없이 PR" 우회 경로의 **구조적 차단선**. (Host-side 강제 여부는 §Enforcement Status 표 참고.)

**Payload**:

```json
{
  "commandId": "CONTINUE_SESSION",
  "params": {
    "prompt": "$z phase2 <ISSUE_URL or task-slug>\n\n<z-handoff type=\"plan-to-work\">\n## Issue\n<ISSUE_URL or \"none (Case A escape, tier=tiny|small)\">\n## Parent Epic\n<EPIC_URL or \"none\">\n## Tier\n<tiny|small|medium|large|xlarge>\n## Escape Eligible\n<true|false>\n## Issue Required By User\n<true|false>\n## Original Request Excerpt\n<원 유저 SSOT instruction 발췌 — 수신 세션이 escape 조건 및 scope를 재검증 가능하게>\n## Repository Policy\n<issue-required: true|false — CONTRIBUTING/policy가 이슈 선행을 요구하는지 여부>\n## Confirmed Plan\n<plan markdown — Goal / Scope / Done>\n## Task List\n- [ ] task 1\n- [ ] task 2\n## Codex Review\nscore: <N>/100 — <verdict>\n</z-handoff>",
    "resetSession": true,
    "dispatchText": "<ISSUE_URL or task-slug>",
    "forceWorkflow": "z-plan-to-work"
  }
}
```

**Producer-authoritative typed fields** (host persists these verbatim as `session.handoffContext`):

- `## Tier` — `using-epic-tasks` 판정 tier.
- `## Escape Eligible` — Case A 3-condition validation 통과 여부 (단순 마커 존재가 아닌 검증 통과).
- `## Issue Required By User` — 유저 원 요청에 선행 이슈 요구 존재 여부.

모두 optional — 누락 시 conservative defaults (tier=null, escapeEligible=false, issueRequiredByUser=true). 명시할수록 downstream host guards가 신뢰할 수 있는 상태를 본다.

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
    "forceWorkflow": "z-epic-update"
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

### Sentinel Grammar

`<z-handoff>` 블록 감지와 파싱 규칙. 느슨한 매칭은 오라우팅/우회 벡터.

1. **Exact form.** 여는 태그는 정확히 `<z-handoff type="plan-to-work">` 또는 `<z-handoff type="work-complete">` — 대소문자 구분, 속성은 쌍따옴표 고정. 변형(대소문자·홑따옴표·공백 변형) 불매칭.
2. **Top-level only.** sentinel은 **dispatched prompt의 최상위 래퍼**로만 인정. 유저가 이슈 코멘트·버그 리포트에 이전 handoff 블록을 **인용**한 경우는 sentinel 아님 — 반드시 handoff 본문이 `$z ...` 커맨드 라인 바로 아래의 최상위 블록이어야 함. 애매하면 sentinel 아님으로 판정 (fall-through to normal phase0).
3. **Closing tag 필수.** 여는 태그는 있으나 `</z-handoff>`가 없으면 **malformed** → safe-stop + 유저 에러 출력. 조용한 fall-through 금지.
4. **Required fields 검증.** `type="plan-to-work"`은 `## Issue`, `## Parent Epic`, `## Task List` 세 섹션 필수. `type="work-complete"`은 `## Completed Subissue`, `## PR`, `## Summary`, `## Remaining Epic Checklist` 네 섹션 필수. 누락 시 malformed → safe-stop. `plan-to-work`의 **optional typed-metadata fields** (producer-authoritative, host가 `session.handoffContext`로 persist): `## Tier`, `## Escape Eligible`, `## Issue Required By User`. 누락 시 host는 conservative defaults를 사용하지만 downstream host guard가 정확히 동작하려면 producer가 명시 권장.
5. **Duplicate sentinels.** 한 prompt에 `plan-to-work`와 `work-complete`가 동시 등장하면 **hard error** — 어느 쪽도 선택하지 않고 safe-stop. 같은 type이 두 번 나와도 마찬가지.
6. **원요청 재검증 가능성.** `plan-to-work` 블록은 `## Original Request Excerpt` 필드로 원본 유저 SSOT instruction을 발췌 carrying — 수신 세션이 Case A escape 조건(또는 기타 계약)을 재검증 가능하게.

### Protocol Rules (host enforcement pending)

1. **Handoff #1 선행조건 충족 전 호출 금지**. Case A/B는 Issue URL, Case A escape는 (tier=`tiny`|`small` ∧ 원요청에 선행 이슈 요구 없음 ∧ 레포 정책이 이슈-필수 요구하지 않음) **세 조건 모두** 충족 시에만 escape 마커. 어느 하나라도 빠지면 handoff 중단 + phase1 복귀.
2. `resetSession: true` 필수. 세션 컨텍스트 누적 금지.
3. **Handoff 예산 — 세션당 자동 1회**. 한 세션은 자동 handoff를 **최대 1회** 발행할 수 있다. 단, handoff로 시작된 **새 세션은 자신의 수명주기에서 다시 1회**를 발행할 수 있다 (phase2 구현 세션이 phase5에서 Handoff #2를 발행하는 것은 이 예산 안). 금지되는 것은: 한 세션 안에서 두 번 이상 발행, 또는 `work-complete` 수신 세션이 다음 서브이슈를 자동 체인으로 발행하는 것.
4. `<z-handoff>` sentinel 없는 prompt는 직접 유저 요청이므로 phase0부터 정상 진행.
5. `forceWorkflow: "z-plan-to-work"` (Handoff #1) 또는 `"z-epic-update"` (Handoff #2) 사용. 이 workflow 타입들은 host-level로 구현되어 — host가 sentinel 존재/유효성/type 매핑을 검증하고 safe-stop (누락/malformed/mismatch 시). 기존 `"default"` 값은 legacy path로만 유효하며 결정적 새 세션 진입 보장이 없음.
6. payload의 `<z-handoff>` 블록 안에는 **구현 토큰(파일 경로, 함수명, ENV) 금지** — `using-ha-thinking` 규율. Summary / Plan은 behavior 레벨.

### Enforcement Status

현재 규율 수준과 목표:

| 항목 | 현재 강제 수단 | 목표 강제 수단 |
|---|---|---|
| Handoff #1 전 Issue URL 검증 | **구현 완료 (#696)** — `src/hooks/pr-issue-guard.ts` via in-process SDK PreToolUse hook (Bash + MCP) + prompt 계약 (defense-in-depth) | — |
| 결정적 새 세션 진입 | **구현 완료 (#695)** — 전용 `WorkflowType` (`z-plan-to-work`, `z-epic-update`) + host sentinel 검증 + `session.handoffContext` typed persistence | — |
| 세션당 handoff 예산 | **구현 완료 (#697)** — `src/slack/handoff-budget.ts` + `slack-handler.onResetSession` 가드; `ConversationSession.autoHandoffBudget` 필드 (default 1, `resetSessionContext`에서 재초기화); 호스트-빌트 continuation (renew/onboarding)은 `Continuation.origin: 'host'` 마커로 제외 | — |
| 1-hop 재귀 방지 | **구현 완료 (#697)** — 세션 예산 고갈 시 `HandoffBudgetExhaustedError` throw + slack-handler 외부 catch에서 safe-stop (`#695`의 `HandoffAbortError` 패턴과 동일, 단 session terminate는 하지 않음 — 수동 재입력 대기) | — |
| Dispatch 실패 복구 | z handoff 경로는 safe-stop 구현 (#695 — `HandoffAbortError`) | default fallback 제거 일반화 (#698) |

**이 스킬 문서는 핸드오프 계약을 정의한다. 항목별 host-side 강제 진척은 위 표에 단일 진실원으로 기록한다.** 본문에 PR/이슈 번호를 박지 않는다 — 시간이 지나면 노이즈가 되고, 구체 추적은 위 표(또는 그 표가 가리키는 에픽)가 소유한다.

## Invariants (general)

1. 진입 스킬 선택은 **Decision Table**을 따른다.
2. `decision-gate` 호출은 **`z` phase0에서 1회만**. using-epic-tasks는 phase0이 전달한 tier를 신뢰 — 재호출 금지 (중복 방지).
3. approve/CI 게이트 규칙과 "1 서브이슈 = 1 PR" 같은 작업 단위 규율은 각 스킬이 소유 (여기서 복제 금지).
4. `using-epic-tasks`가 Case C 판정 시 `z`는 작업 시작 전 중단 후 유저 분해 승인 대기 (phase0.2).
5. Session handoff는 위 **Session Handoff Protocol**을 따른다. z / zwork는 해당 계약을 구현.
