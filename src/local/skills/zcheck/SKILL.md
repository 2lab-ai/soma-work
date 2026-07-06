---
name: zcheck
description: "Post-implementation gate. Trigger before asking the user for approval, and just after you think work is done. Runs CI + review-comment resolution + ztrace coverage check. Invoked by local:z phase3 after zwork produces a PR."
---

# zcheck — Post-Implementation Verification Gate

PR이 mergeable 상태가 될 때까지 루프

## Input

- PR URL or `owner/repo#number`

## Step 0: Update bracnh

1. base branch로 새로 `rebase` 한다. 충돌이 발생하면 충돌을 처리한다.
2. Invoke `local:simplify` (fix mode) on the `origin/main...HEAD` diff.

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

1. 유저에게 이슈와 approve를 요청할 **PR 링크**를 보낸다 `local:UIAskUserQuestion`으로 approve 요청. 리뷰 코멘트 해결 수, CI 상태, 변경 범위를 보낸다.

옵션 텍스트는 `../UIAskUserQuestion/templates/zcheck-pr-approve.json` 템플릿을 그대로 사용한다 (question / context / choices A~D 전부 그 파일이 단일 진실원 — 여기서 재정의하지 않는다). 각 옵션의 의미만 요약:
- Option A: approve → 머지 → `local:es` → 다음 phase 자동 진행 (RATE +1).
- Option B: `local:ztrace` 재실행 요청, 더 엄격한 브리핑 (RATE -2).
- Option C: `local:zcheck` 재실행 요청, CI 체크부터 다시 (RATE -3).
- Option D: `local:z` 처음부터 재실행 요청, 빠진 절차 복구 (RATE -5).


## Invariants

- Unresolved 코멘트 있으면 approve 요청 금지.
- CI 실패 중이면 approve 요청 금지.
- **미커버 `ssot-task`가 있으면 approve 요청 금지** (Step 3 Coverage check).
- 코드 변경 → Step 1 재시작.
