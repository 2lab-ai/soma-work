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
| `<z-handoff type="plan-to-work">` sentinel 포함 prompt | `z` — phase 0.0 sentinel scan에서 감지 → phase 2 controller (2.0 bootstrap → 2.1 repeat-back gate → 그룹 단위 implementer subagent dispatch) | Handoff #1 결과. clarify/plan 재실행 금지 |
| `<z-handoff type="work-complete">` sentinel 포함 prompt | `z` — phase 0.0 sentinel scan에서 감지 → phase 5.E controller (epic-update subagent dispatch + 수동 close UIAskUserQuestion) | Handoff #2 결과. plan 단계 생략 |
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
    "prompt": "$z phase2 <ISSUE_URL or task-slug>\n\n<z-handoff type=\"plan-to-work\">\n## Issue\n<ISSUE_URL or \"none (Case A escape, tier=tiny|small)\">\n## Parent Epic\n<EPIC_URL or \"none\">\n## Tier\n<tiny|small|medium|large|xlarge>\n## Escape Eligible\n<true|false>\n## Issue Required By User\n<true|false>\n## Original Request Excerpt\n<원 유저 SSOT instruction 발췌 — 수신 세션이 escape 조건 및 scope를 재검증 가능하게>\n## Repository Policy\n<issue-required: true|false — CONTRIBUTING/policy가 이슈 선행을 요구하는지 여부>\n## Confirmed Plan\n<plan markdown — Goal / Scope / Done>\n## Task List\n- [ ] task 1\n- [ ] task 2\n## Dependency Groups\nGroup 1: [task-id-A, task-id-B]\nGroup 2: [task-id-C]\n## Per-Task Dispatch Payloads\n### task-id-A\n````\n<self-contained subagent prompt — worktree path placeholder, branch, base, file/line changes, tests, commands, commit/PR templates. MAY contain inner ``` code blocks for commit-message HEREDOC, PR body, language-tagged examples — outer 4-backtick fence keeps them safe.>\n````\n### task-id-B\n````\n<self-contained subagent prompt …>\n````\n### task-id-C\n````\n<self-contained subagent prompt …>\n````\n## Codex Review\nscore: <N>/100 — <verdict>\n</z-handoff>",
    "resetSession": true,
    "dispatchText": "<ISSUE_URL or task-slug>",
    "forceWorkflow": "z-plan-to-work"
  }
}
```

**Producer-authoritative typed fields** (host persists these verbatim as `session.handoffContext`):

**Optional (host applies conservative defaults if missing):**

- `## Tier` — `using-epic-tasks` 판정 tier. 누락 시 null.
- `## Escape Eligible` — Case A 3-condition validation 통과 여부 (단순 마커 존재가 아닌 검증 통과). 누락 시 false.
- `## Issue Required By User` — 유저 원 요청에 선행 이슈 요구 존재 여부. 누락 시 true (보수적).

**Display-only required heading (host parser checks heading presence only, no semantic validation):**

- `## Task List` — human-friendly checklist that the new session registers into TodoWrite for progress display. Canonical task IDs come from `## Dependency Groups` / `## Per-Task Dispatch Payloads`; the Task List is **not** cross-validated against them. Use it to give the user a readable summary, not as a parser source-of-truth.

**Required (host parser rejects the handoff with `invalid-plan-payload` if missing or empty):**

- `## Dependency Groups` — phase 1 planner의 dependency-group 분할. 새 세션 phase 2가 그룹 단위 병렬 dispatch를 결정하기 위해 필수. 비어 있으면 새 세션은 PLAN.md를 직접 파싱하지 못하므로 phase 2를 진행할 수 없음 (z 컨트롤러는 repo 파일을 읽지 않는다). Host parser는 빈 그룹을 `invalid-plan-payload (empty-dependency-groups)`로 거부.
- `## Per-Task Dispatch Payloads` — task-id별 self-contained subagent 프롬프트. 각 `### task-id` 본문은 **4개 이상의 backtick으로 감싸야 함** (`` ```` … ```` ``). 3-backtick fence는 거부됨 — planner가 작성하는 실제 프롬프트는 commit message HEREDOC / PR body / language-tagged code 등 inner 3-backtick code block을 포함하므로, 3-tick outer fence는 첫 inner 3-tick block에서 종료되어 payload가 잘려 나간다. Host parser는: (a) 각 group taskId가 정확히 하나의 4+-tick fenced payload와 매칭되는지 cross-validate, (b) group / payload 모두 duplicate taskId 거부, (c) opening fence 후 매칭되는 closing fence가 없으면 `unclosed-payload-fence:<taskId>`로 거부, (d) 미스매치 시 `group-task-without-payload:<id>` 또는 `payload-task-without-group:<id>`로 거부. 모든 실패는 `invalid-plan-payload` reason + 구체적 detail로 surface된다.

**새 세션 z phase0 동작**:

1. prompt에서 `<z-handoff type="plan-to-work">` 탐지.
2. clarify / new-task / codex 리뷰 단계 **스킵**.
3. Task List를 TodoWrite로 등록.
4. Issue URL + Parent Epic + Original Request Excerpt + Repository Policy + Dependency Groups + Per-Task Dispatch Payloads를 세션 전역 SSOT로 보관.
5. **`local:z` phase 2의 컨트롤러 시맨틱으로 진입**한다 — `local:zwork`를 직접 invoke하지 않는다. 새 세션은 z 오케스트레이터로서 (a) **phase 2.0 bootstrap subagent** (working folder 생성 + clone + per-task worktrees 생성, blocking), (b) phase 2.1 repeat-back gate, (c) Dependency Groups 순회, (d) 각 그룹 내 Per-Task Dispatch Payloads를 verbatim으로 implementer subagent에 dispatch (`Agent`, `general-purpose`, `run_in_background:true`), (e) push 모델로 대기. zwork 워크플로 prompt가 시키는 "직접 implementer로 행동" 지시는 본 컨트랙트와 충돌하므로 무효 — `z-plan-to-work` 워크플로 prompt는 z phase 2 컨트롤러로 라우팅한다.

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

1. prompt에서 `<z-handoff type="work-complete">` 탐지.
2. clarify / plan 단계 **스킵**.
3. **`local:z` phase 5.E의 컨트롤러 시맨틱으로 진입** — 직접 GitHub mutation 금지. 다음 단계는 모두 subagent dispatch로 처리:
   - epic 이슈에 Summary를 코멘트로 포스팅 → epic-update subagent.
   - epic body Checklist 갱신 (`[ ]` → `[x]`) → 동일 subagent.
4. **Epic close 정책 — 수동 close 유지** (`using-epic-tasks/reference/github.md` §3 + SKILL.md Invariant 4: 에픽은 사람이 Done-Done 검증 후 수동 close).
   - epic-update subagent는 절대 epic을 자동 close하지 않는다.
   - 모든 서브이슈가 closed + 체크리스트 전부 `[x]`이면 z 오케스트레이터가 `UIAskUserQuestion`으로 "에픽 close하시겠습니까?" 결정 요청. 유저 승인 시 close subagent dispatch.
   - 미완료 서브이슈 있으면 목록만 유저에게 출력하고 끝낸다.
5. **자동으로 다음 서브이슈의 Handoff #1을 연쇄하지 않음** — 유저가 직접 `$z <next_subissue_url>` 입력하도록 유지 (Protocol Rules #3, hop budget = 1).
6. `z-epic-update` 워크플로 prompt가 시키는 "직접 코멘트/체크리스트/close 실행" 지시는 본 컨트랙트와 충돌 — 워크플로 prompt는 z phase 5.E 컨트롤러로 라우팅한다.

### Sentinel Grammar

`<z-handoff>` 블록 감지와 파싱 규칙. 느슨한 매칭은 오라우팅/우회 벡터.

1. **Exact form.** 여는 태그는 정확히 `<z-handoff type="plan-to-work">` 또는 `<z-handoff type="work-complete">` — 대소문자 구분, 속성은 쌍따옴표 고정. 변형(대소문자·홑따옴표·공백 변형) 불매칭.
2. **Top-level only.** sentinel은 **dispatched prompt의 최상위 래퍼**로만 인정. 유저가 이슈 코멘트·버그 리포트에 이전 handoff 블록을 **인용**한 경우는 sentinel 아님 — 반드시 handoff 본문이 `$z ...` 커맨드 라인 바로 아래의 최상위 블록이어야 함. 애매하면 sentinel 아님으로 판정 (fall-through to normal phase0).
3. **Closing tag 필수.** 여는 태그는 있으나 `</z-handoff>`가 없으면 **malformed** → safe-stop + 유저 에러 출력. 조용한 fall-through 금지.
4. **Required fields 검증.** `type="plan-to-work"`은 `## Issue`, `## Parent Epic`, `## Task List`, `## Dependency Groups`, `## Per-Task Dispatch Payloads` 다섯 섹션 필수. `type="work-complete"`은 `## Completed Subissue`, `## PR`, `## Summary`, `## Remaining Epic Checklist` 네 섹션 필수. 누락 시 malformed → safe-stop. `plan-to-work`의 **optional typed-metadata fields** (producer-authoritative, host가 `session.handoffContext`로 persist): `## Tier`, `## Escape Eligible`, `## Issue Required By User`, `## Original Request Excerpt`, `## Repository Policy`, `## Codex Review`. 누락 시 host는 conservative defaults를 사용하지만 downstream host guard가 정확히 동작하려면 producer가 명시 권장. (Dependency Groups + Per-Task Dispatch Payloads는 phase 2 controller가 PLAN.md를 직접 파싱하지 못하므로 required로 승격됨.)
5. **Duplicate sentinels.** 한 prompt에 `plan-to-work`와 `work-complete`가 동시 등장하면 **hard error** — 어느 쪽도 선택하지 않고 safe-stop. 같은 type이 두 번 나와도 마찬가지.
6. **원요청 재검증 가능성.** `plan-to-work` 블록은 `## Original Request Excerpt` 필드로 원본 유저 SSOT instruction을 발췌 carrying — 수신 세션이 Case A escape 조건(또는 기타 계약)을 재검증 가능하게.

### Protocol Rules (host enforcement pending)

1. **Handoff #1 선행조건 충족 전 호출 금지**. Case A/B는 Issue URL, Case A escape는 (tier=`tiny`|`small` ∧ 원요청에 선행 이슈 요구 없음 ∧ 레포 정책이 이슈-필수 요구하지 않음) **세 조건 모두** 충족 시에만 escape 마커. 어느 하나라도 빠지면 handoff 중단 + phase1 복귀.
2. `resetSession: true` 필수. 세션 컨텍스트 누적 금지.
3. **Handoff 예산 — 세션당 자동 1회**. 한 세션은 자동 handoff를 **최대 1회** 발행할 수 있다. 단, handoff로 시작된 **새 세션은 자신의 수명주기에서 다시 1회**를 발행할 수 있다 (phase2 구현 세션이 phase5에서 Handoff #2를 발행하는 것은 이 예산 안). 금지되는 것은: 한 세션 안에서 두 번 이상 발행, 또는 `work-complete` 수신 세션이 다음 서브이슈를 자동 체인으로 발행하는 것.
4. `<z-handoff>` sentinel 없는 prompt는 직접 유저 요청이므로 phase0부터 정상 진행.
5. `forceWorkflow: "z-plan-to-work"` (Handoff #1) 또는 `"z-epic-update"` (Handoff #2) 사용. 이 workflow 타입들은 host-level로 구현되어 — host가 sentinel 존재/유효성/type 매핑을 검증하고 safe-stop (누락/malformed/mismatch 시). 기존 `"default"` 값은 legacy path로만 유효하며 결정적 새 세션 진입 보장이 없음.
6. payload의 `<z-handoff>` 블록 안 **behavior-level 섹션**에는 구현 토큰(파일 경로, 함수명, ENV) 금지 — `using-ha-thinking` 규율. behavior-level 섹션 = `## Issue`, `## Parent Epic`, `## Tier`, `## Escape Eligible`, `## Issue Required By User`, `## Original Request Excerpt`, `## Repository Policy`, `## Confirmed Plan`, `## Task List`, `## Codex Review` (plan-to-work) + `## Completed Subissue`, `## PR`, `## Summary`, `## Remaining Epic Checklist` (work-complete). **`## Per-Task Dispatch Payloads`는 carve-out 예외** — 본질적으로 implementer subagent에 전달되는 self-contained 프롬프트이므로 파일 경로·함수명·라인 번호·테스트 명·빌드 커맨드 등 구현 토큰을 포함하는 것이 정상. (대신 `## Summary` 같은 behavior-level 필드에는 같은 토큰을 박지 말 것.)

### Enforcement Status

현재 규율 수준과 목표:

| 항목 | 현재 강제 수단 | 목표 강제 수단 |
|---|---|---|
| Handoff #1 전 Issue URL 검증 | **구현 완료 (#696)** — `src/hooks/pr-issue-guard.ts` via in-process SDK PreToolUse hook (Bash + MCP) + prompt 계약 (defense-in-depth) | — |
| 결정적 새 세션 진입 | **구현 완료 (#695)** — 전용 `WorkflowType` (`z-plan-to-work`, `z-epic-update`) + host sentinel 검증 + `session.handoffContext` typed persistence | — |
| 세션당 handoff 예산 | **구현 완료 (#697)** — `src/slack/handoff-budget.ts` + `slack-handler.onResetSession` 가드; `ConversationSession.autoHandoffBudget` 필드 (default 1, `resetSessionContext`에서 재초기화); 호스트-빌트 continuation (renew/onboarding)은 `Continuation.origin: 'host'` 마커로 제외 | — |
| 1-hop 재귀 방지 | **구현 완료 (#697)** — 세션 예산 고갈 시 `HandoffBudgetExhaustedError` throw + slack-handler 외부 catch에서 safe-stop (`#695`의 `HandoffAbortError` 패턴과 동일, 단 session terminate는 하지 않음 — 수동 재입력 대기) | — |
| Dispatch 실패 복구 | **구현 완료 (#698)** — `src/slack/dispatch-abort.ts` + `session-initializer`의 4개 drift site (classifier catch, in-flight wait-timeout, forceWorkflow `transitionToMain` × 2)가 `DispatchAbortError` throw로 전환; `session.handoffContext` 또는 `forcedWorkflowHint` 있을 때만 safe-stop, 일반 Slack 메시지 경로는 기존 default drift 유지; `slack-handler` widened outer catch에서 `terminateSession` + postMessage with handoff metadata | — |

**이 스킬 문서는 핸드오프 계약을 정의한다. 항목별 host-side 강제 진척은 위 표에 단일 진실원으로 기록한다.** 본문에 PR/이슈 번호를 박지 않는다 — 시간이 지나면 노이즈가 되고, 구체 추적은 위 표(또는 그 표가 가리키는 에픽)가 소유한다.

## Invariants (general)

1. 진입 스킬 선택은 **Decision Table**을 따른다.
2. `decision-gate` 호출은 **`z` phase0에서 1회만**. using-epic-tasks는 phase0이 전달한 tier를 신뢰 — 재호출 금지 (중복 방지).
3. approve/CI 게이트 규칙과 "1 서브이슈 = 1 PR" 같은 작업 단위 규율은 각 스킬이 소유 (여기서 복제 금지).
4. `using-epic-tasks`가 Case C 판정 시 `z`는 작업 시작 전 중단 후 유저 분해 승인 대기 (phase0.2).
5. Session handoff는 위 **Session Handoff Protocol**을 따른다. z / zwork는 해당 계약을 구현.
