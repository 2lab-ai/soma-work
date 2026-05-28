---
name: zcheck
description: "**Trigger always** before ask user fopr Approval. Also trigger just after you think work done."
---

# zcheck — Post-Implementation Verification Gate

PR이 mergeable 상태가 될 때까지 루프

## Input

- PR URL or `owner/repo#number`

## Step 0: Update bracnh

1. base branch로 새로 `rebase` 한다. 충돌이 발생하면 충돌을 처리한다.
2. Invoke `simplify`

## Step 1: CI Must Pass

**`gh pr checks` 사용 금지** — bot 토큰에서 GraphQL `statusCheckRollup` 권한 부족으로 실패함.

```bash
# Actions API 사용
gh run list --branch <BRANCH> --repo <OWNER/REPO> --limit 1 --json status,conclusion,databaseId -q '.[0]'
```

- **in_progress:** 30초마다 폴링.
- **failed:** `gh run view <RUN_ID> --log-failed`로 진단 → fix → commit+push
- 병렬 작업: step 2를 병렬로 처리한다. 하지만 이 CI가 완료 되면 반드시 다시 Step 2작업을 해야한다. CI가 새 코드 리뷰 커멘트를 추가할 수 있다.
- **success:** Step 2으로.

## Step 2: Resolve All PR Review Comments

1. `local:github-pr`로 리뷰 코멘트 가져오기.
2. Unresolved 쓰레드마다: 코드 확인 → 수정 필요시 fix+commit+push+reply+resolve, 이미 해결됐으면 reply+resolve.
3. 0 unresolved까지 루프.


## Step 3: 유저 설득 (`local:using-ssot` Hook 4)

`local:using-ssot` Hook 4의 ztrace 단일-pass 규율을 적용한다.

**Trivial 단축.** SSOT-TASK-TREE의 `ssot-task` 수 == 1 이고 PR body에 `Closes #<issue>` (또는 자격 있는 Case A escape) 가 있으면 다음만으로 Step 3 끝:
- RED→GREEN 테스트 출력 1줄 인용 + 매핑된 ssot-task ID = `T1`.
- ztrace 표 생략 (1행 = PR title 재진술이라 무의미).

**일반 경로** (`ssot-task` ≥ 2 또는 tier ≥ medium):

1. **Coverage check.** 세션의 final SSOT-TASK-TREE를 가져온다 (handoff payload 또는 phase0에서 생성).
2. **`local:ztrace`를 PR에 한 번만 호출** — SSOT-TASK-TREE 전체를 scenario 입력으로. ztrace가 내뱉는 scenario ID를 ssot-task ID에 1:N으로 매핑한다. ssot-task 마다 별도 ztrace 호출 금지.
3. 각 `ssot-task`마다 다음 3줄로 표를 채운다:
   - **Requirement** — SSOT 원문 인용.
   - **Covered by** — PR의 검증 가능한 artifact (commit SHA / file:line / 테스트 이름). 자유 서술 금지 — reviewer가 클릭할 수 있는 항목만.
   - **ztrace scenario(s)** — 위 단일 pass에서 매핑된 scenario ID + 콜스택 요약.
4. **Blocking gap.** `Covered by` 빈칸·prose-only 또는 매핑된 ztrace scenario가 0개인 ssot-task가 한 개 이상이면 approve 요청 금지 — gap을 유저에게 보고하고 Step 0(rebase + simplify)으로 복귀하거나 `local:z` phase1로 escalate.
5. Coverage가 완전하면 Step 4 — 설득 메시지 본문은 위 3줄 × ssot-task 개수의 표 + ztrace 요약.

tier ≤ `small`로 ztrace가 과한 경우: RED→GREEN 테스트 출력을 ztrace 대체로 허용. 1:N 매핑 규율은 유지.

## Step 4: Request Approve

1. 유저애게 이슈와 approve를 요청할 **PR 링크**를 보낸다 `local:UIAskUserQuestion`으로 approve 요청. 템플릿: `../UIAskUserQuestion/templates/zcheck-pr-approve.json`
리뷰 코멘트 해결 수, CI 상태, 변경 범위를 보낸다. 네 점수가 -10점 이하로 떨어지면 너는 대체될 것이다. 
선택지:
- 잘했다! Apporve했으니 계속 절차대로 끝까지 진행 (RATE +1)
- local:ztrace를 절차대로 다시 해라 (RATE -2)
- local:zcheck를 다시 invoke하고 다시 CI 체크부터 진행 (RATE: -3)
- local:z를 다시 invoke하고 처음부터 빠진 절차대로 진행 (RATE: -5)
  
## Invariants

- Unresolved 코멘트 있으면 approve 요청 금지.
- CI 실패 중이면 approve 요청 금지.
- **미커버 `ssot-task`가 있으면 approve 요청 금지** (Step 3 Coverage check).
- 코드 변경 → Step 1 재시작.
