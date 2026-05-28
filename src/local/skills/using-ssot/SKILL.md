---
name: using-ssot
description: "SSOT / SSOT-LIST / SSOT-TASK-TREE 단일 출처. 유저의 raw 지시를 어떻게 보존하고, 모델이 수행 가능한 atomic·self-contained task의 의존성 트리로 분해하고, drift 시 업데이트하고, 완료 시 계층 보고하는지 정의한다. autoz / z / zfix / es / zcheck / zreflect / using-epic-tasks가 참조한다."
---

# using-ssot — Single Source of Truth for user instructions

유저의 지시를 다루는 모든 z-계열 스킬이 공유하는 단일 출처. 여기서 정의를 박고, 다른 스킬은 lifecycle hook(진입 / drift / 완료 보고)에서 이 문서를 참조한다.

## Definitions

### SSOT
- 유저의 **raw 입력 내용**. 한 글자도 paraphrase 하지 않음. 따옴표·줄바꿈·이모지 포함.
- 예: 슬랙 메시지, 이슈 본문, PR 코멘트, 추가로 들어온 drift 지시.
- 소스가 **링크**(JIRA · GitHub issue · 외부 URL)면 해당 링크를 fetch하여 link target의 본문까지 self-contained하게 SSOT에 합쳐 보관한다 — "여기 적힌 대로 해줘"가 후속 세션·핸드오프에서도 재현되도록.

### SSOT-LIST
- 유저의 raw 입력 **리스트**(시간 순).
- 첫 진입 시: `SSOT-LIST = [SSOT_1]`.
- 새 drift 지시가 들어올 때마다 마지막에 append. **삭제·수정·요약 금지.**
- 완전한 SSOT-LIST는 언제든 그대로 재출력 가능해야 한다 — 후속 세션의 phase0 입력으로 그대로 쓸 수 있어야 함.

### SSOT-TASK-TREE
- 유저의 SSOT-LIST를 모델이 **이행 가능한** psuedo-atomic·self-contained task의 **의존성 트리**.
- 트리 노드는 두 종류:
  - **ssot-task** — 유저의 SSOT에서 분해한 task. 실제 SSOT 텍스트와 거의 **1:1로 매칭**되며, 트리 안에서 "왜 존재하는가"를 SSOT의 어느 문장 / 어느 요건으로 정당화할 수 있어야 한다. ssot-task의 raison d'être는 SSOT 안에서 스스로 증명된다.
  - **ssot-subtask** — ssot-task를 해결하기 위해 **모델이 만든** 하위 task. 유저의 raw 지시에 명시되지 않음. **유저의 신규 지시로 SSOT-TASK-TREE가 업데이트될 때 통째로 폐기되고 새로 만든다.** 유저에게 리포트할 때는 **생략 가능**(필요시 한 단계 더 들어간 디테일로만 첨부).

#### Tree shape

```
SSOT-TASK-TREE
├── ssot-task #1   ← SSOT_1의 첫 번째 요건
│   ├── ssot-subtask #1.1
│   ├── ssot-subtask #1.2
│   └── ssot-subtask #1.3 → depends-on: #2 (다른 ssot-task)
├── ssot-task #2   ← SSOT_1의 두 번째 요건
│   └── ssot-subtask #2.1
└── ssot-task #3   ← SSOT_2 (drift)에서 추가된 요건
    └── ssot-subtask #3.1
```

- 의존성은 ssot-task 사이에도, ssot-subtask 사이에도 명시 가능. cycle 금지.
- ssot-task는 항상 SSOT-LIST의 어느 문장 / 요건에 묶여 있다. "이건 어디서 왔지?"가 즉답 가능해야 함.

## Lifecycle hooks

z-계열 스킬은 아래 4개 지점에서 이 문서의 규율을 호출한다.

### Hook 1 — Initial intake (모든 진입 스킬)

유저 지시가 처음 들어오면:

1. 유저의 raw 지시를 **그대로** SSOT로 박는다 (paraphrase 금지).
2. 지시가 URL 한 줄이면 issue/PR/문서 본문을 fetch → SSOT를 self-contained 형태로 확장.
3. `SSOT-LIST = [SSOT]`로 초기화.
4. **SSOT-TASK-TREE를 생성** — 유저 지시를 atomic·self-contained task의 의존성 트리로 분해. ssot-task만으로 트리를 먼저 그린 뒤, 각 ssot-task 아래 ssot-subtask를 채운다.
5. **즉시 출력** — 유저가 한 화면에서 다음을 볼 수 있게:
   - SSOT (또는 SSOT-LIST) 원문
   - SSOT-TASK-TREE (ssot-task + ssot-subtask)
   - 각 ssot-task가 SSOT의 어느 부분에서 도출되었는지 mapping
6. **TodoWrite 등록** — SSOT-TASK-TREE의 모든 leaf(주로 ssot-subtask, ssot-subtask가 없는 ssot-task는 자기 자신)를 task list로 등록.
7. 유저가 끼어들 수 있게 진행 전 가시화. (`autoz`는 출력만 하고 진행. 일반 `z`는 plan 단계에서 명시적 confirm 받음 — 각 스킬의 정책을 따른다.)

### Hook 2 — Drift (추가 지시 수신)

세션 중 유저가 추가·교정·범위 변경 지시를 보내면:

1. 새 raw 지시를 SSOT_n으로 추가 → `SSOT-LIST.append(SSOT_n)`.
2. **완전한 SSOT-LIST를 다시 그대로 출력** — 시간 순으로, 원문 그대로.
3. SSOT-LIST 전체로 SSOT-TASK-TREE를 **새로 생성** (Hook 1 step 4와 동일 방식).
4. **기존 SSOT-TASK-TREE와 diff** — 단, 비교는 **ssot-task 레벨**에서만 한다. ssot-subtask는 모델이 만든 임시 분해라 통째로 폐기·재생성된다(정의에 따라).
   - `added` ssot-task: 새 지시로 추가된 요건.
   - `removed` ssot-task: 유저가 명시적으로 철회·반박한 요건만. drift가 단순 확장이면 항상 빈 집합.
   - `changed` ssot-task: 같은 요건이지만 acceptance / scope가 바뀜 — 둘 다 표시.
   - `kept` ssot-task: 그대로.
5. **완료/진행 상태를 반영** — 기존 트리에서 이미 완료된 ssot-task는 새 트리에 `[x]`로 carry-over. 진행 중이던 ssot-subtask는 새 ssot-task 아래 동일한 분해가 다시 만들어졌을 때만 동등 노드에 carry-over, 아니면 폐기.
6. **diff 결과 + 갱신된 SSOT-TASK-TREE를 출력**.
7. TodoWrite 갱신 — 추가/삭제/변경된 노드 반영.
8. **이어서 작업** — 처음부터 다시 시작하지 않는다. 새 트리의 미완료 leaf에서 계속.

### Hook 3 — Resume / Handoff (세션 경계)

세션 핸드오프(`local:using-z` §Session Handoff Protocol)나 외부 재진입 시:

1. SSOT-LIST 전체와 SSOT-TASK-TREE를 handoff payload에 포함 — payload가 self-contained해야 새 세션이 동일한 트리에서 작업 재개 가능.
2. 새 세션은 진입 즉시 SSOT-LIST + SSOT-TASK-TREE를 출력하고, TodoWrite에 등록한 뒤 미완료 leaf부터 진행.

### Hook 4 — Completion report (`es`, autoz terminal report, zcheck 설득 단계)

작업 완료를 유저에게 보고할 때 SSOT-TASK-TREE를 보고서 골격으로 쓴다. **계층적**으로 설명:

1. **Top level — overall summary**
   - SSOT-LIST 한 줄 요약 → "유저가 시킨 일은 결국 이것"
   - 결과 한 줄 요약 → PR/이슈 링크 + 상태
2. **Mid level — ssot-task 별 mapping**
   - 각 ssot-task에 대해:
     - 유저의 원 요건 인용 (SSOT의 해당 문장)
     - 무엇을 했는가 (구체 artifact: PR · 커밋 · 파일 · 함수)
     - **왜 그 행동이 이 요건을 충족하는가** — 행동-요건 인과 관계 명시
3. **Bottom level — ssot-subtask 디테일** (필요할 때만)
   - 보고 대상이 디테일을 원할 때만 펼친다. 기본은 접어둔다.
4. **Verification (required).** 보고된 mapping은 `local:ztrace` **단일 pass** 결과로 뒷받침해야 한다 — ztrace에 SSOT-TASK-TREE 전체를 scenario 입력으로 던지고, ztrace가 내뱉는 scenario ID를 ssot-task ID에 다시 매핑한다. ssot-task 마다 별도 ztrace 호출 금지(N회 폭주 방지). 매핑되지 않은 ssot-task가 한 개라도 있으면 보고 미완 — 완료 보고를 닫지 않는다. tier ≤ `small`로 ztrace가 과한 경우, RED→GREEN 테스트 출력으로 대체 가능하되 같은 1:N 매핑 규율은 유지.

## Output format

### Initial / drift 시 출력 (Hook 1 · 2)

```
## SSOT-LIST (시간 순)
1. (timestamp/source) "유저 raw 메시지 1"
2. (timestamp/source) "유저 raw 메시지 2"   ← drift 시 추가 표시
...

## SSOT-TASK-TREE
- [ ] **T1** — <ssot-task 1, SSOT_1: "원문 인용..."에서 도출>
  - [ ] **T1.1** — <ssot-subtask>
  - [x] **T1.2** — <ssot-subtask, 완료>
- [ ] **T2** — <ssot-task 2>
  - depends-on: T1
  - [ ] **T2.1** — <ssot-subtask>

## Diff vs previous tree   ← drift 시에만
- added: T3
- changed: T1 (scope: A → A∪B)
- kept: T2

## Next
- 이어서 진행할 leaf: T2.1, T3.1
```

### Completion 시 출력 (Hook 4)

`local:es` 모드 템플릿에 SSOT-TASK-TREE 섹션을 끼워 넣는다. 정확한 형식은 `es/reference/templates/<mode>.md` 참고. 핵심은:

- SSOT 인용 → 무엇을 했는가 → 왜 그것이 SSOT를 충족하는가 — 이 3단을 ssot-task마다 반복.

## TodoWrite mapping

- ssot-task가 leaf(ssot-subtask 없음) → TodoWrite 1 entry로 등록.
- ssot-task가 ssot-subtask를 가짐 → 각 ssot-subtask가 TodoWrite entry. parent ssot-task는 별도 entry로 등록하지 않거나, 그룹 라벨로만 둠.
- drift로 트리가 갱신되면 영향받은 entry만 add/remove. 단순히 전체 wipe & rewrite는 진행 정보 유실.

## Invariants

1. **SSOT는 paraphrase 금지.** raw text가 SSOT의 본질. 청소·요약·"정리"는 별도 출력 영역에서.
2. **SSOT-LIST는 append-only.** 유저가 명시적으로 "이전 지시 철회"라고 해도 SSOT-LIST에서 지우지 않는다 — 철회는 새 SSOT 항목으로 명시한다 ("위에서 X라고 했던 것은 취소한다").
3. **ssot-task는 SSOT 안에서 자기 존재를 증명할 수 있어야 한다.** 어디서 왔는지 즉답 가능. 안 되면 ssot-subtask로 강등.
4. **ssot-subtask는 휘발성.** drift 시 트리 재생성 = ssot-subtask 폐기 + 재생성. 영구 산출물(PR 본문, 이슈 body) 안에 그대로 박지 않는다.
5. **drift 처리는 새 세션이 아니라 같은 세션의 같은 트리에서 이어진다** — append + diff + resume. wipe + restart 금지.
6. **완료 보고는 SSOT-TASK-TREE를 골격으로** — 작업 narrative가 아니라 ssot-task ↔ 결과 mapping.
7. **링크형 SSOT는 self-contained하게 확장한다** — JIRA / GitHub 링크면 본문 fetch.

## Anti-patterns

- 유저 지시를 "정리"한 paraphrase를 SSOT로 박기.
- drift 지시를 받았는데 SSOT-LIST는 그대로 두고 기존 트리를 즉흥 수정.
- drift마다 트리를 wipe + restart해서 이미 끝난 ssot-task를 다시 실행.
- ssot-subtask를 ssot-task처럼 다뤄서 유저에게 "당신이 시킨 일"이라고 보고.
- ssot-task ↔ 결과 mapping 없이 narrative만 있는 완료 보고.
- 링크 SSOT를 fetch하지 않고 "이슈 #1234 처리 완료"만 보고 → 핸드오프 시 다음 세션이 SSOT를 못 본다.

## Integration

| Skill | Hook | 호출 방식 |
|---|---|---|
| `local:autoz` | 1 (output only, no wait) · 2 · 3 · 4 | autoz는 사용자에게 안 묻지만, SSOT-TASK-TREE 출력 + drift 처리 + terminal report에서 본 문서를 따른다. |
| `local:z` phase0 | 1 (output + plan confirm) | phase0 step 2~4를 본 문서의 Hook 1로 대체. |
| `local:z` phase5 | 4 (via `es`) | terminal `es` 호출에 SSOT-TASK-TREE 섹션 포함. |
| `local:zwork` | 3 (resume) | session handoff payload에서 SSOT-LIST + tree 복원. |
| `local:zreflect` | 2 (drift trigger) | re-instruction = drift. zreflect가 Hook 2를 트리거. |
| `local:zcheck` Step 3 (설득) | 4 (partial) | ztrace 결과를 ssot-task 단위로 mapping. |
| `local:es` | 4 | brief/issue/epic 모드 모두 SSOT-TASK-TREE 섹션을 carry. |
| `local:using-z` Session Handoff | 3 | handoff payload spec에 SSOT-LIST + tree carrying을 추가. |
| `local:using-epic-tasks` | 1 (case routing input) | Case A/B/C 분류 입력으로 SSOT-TASK-TREE 사용. ssot-task = 후보 이슈, ssot-subtask = PR 단위 후보. |
| `local:decision-gate` | 1 (tier signal) | 트리의 깊이·폭·외부 의존도가 xlarge / xxlarge 신호. |
| `local:zfix` | gap diff | "이미 구현된 것"과 SSOT-TASK-TREE 사이의 gap 분석. |
| `stv:do-work` | 3 (resume queue) | 큐 작업 진입 시 해당 작업의 SSOT-LIST + tree 로드. |
