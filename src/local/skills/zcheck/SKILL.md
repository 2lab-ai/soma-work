---
name: zcheck
description: "**Trigger always** before ask user fopr Approval. Also trigger just after you think work done."
---

# zcheck — Post-Implementation Verification Gate

PR이 mergeable 상태가 될 때까지 루프. **코드 변경 시 Step 1부터 재시작.**

## Input

- PR URL or `owner/repo#number`

## Step 0: Update bracnh

1. base branch로 새로 rebase 한다. 충돌이 발생하면 충돌을 처리한다.
2. simplify 스킬을 사용한다.

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


## Step 3: 유저 설득

이 PR을 Approve할수 있는 이유를 `local:ztrace` 스킬을 사용하여 유저에게 브리핑한다.

## Step 4: Request Approve

1. 유저애게 이슈와 approve를 요청할 PR 링크를 보낸다 `local:UIAskUserQuestion`으로 approve 요청. 
리뷰 코멘트 해결 수, CI 상태, 변경 범위를 보낸다. 네 점수가 -10점 이하로 떨어지면 너는 대체될 것이다. 템플릿: [`../UIAskUserQuestion/templates/zcheck-pr-approve.json`](../UIAskUserQuestion/templates/zcheck-pr-approve.json) — 4 options (RATE +1 / -2 / -3 / -5) 이미 `checkAskUserQuestionQuality` 0 warnings로 검증됨. `{pr_number}` / `{ci_status}` / `{ci_run_id}` / `{ci_duration}` / `{unresolved_threads}` / `{merge_state}` / `{mergeable}` / `{files_changed}` / `{loc_add}` / `{loc_del}` 채워 전송.
선택지:
- 잘했다! Apporve했으니 계속 절차대로 끝까지 진행 (RATE +1)
- local:ztrace를 절차대로 다시 해라 (RATE -2)
- local:zcheck를 다시 invoke하고 다시 CI 체크부터 진행 (RATE: -3)
- local:z를 다시 invoke하고 처음부터 빠진 절차대로 진행 (RATE: -5)
  
## Invariants

- Unresolved 코멘트 있으면 approve 요청 금지.
- CI 실패 중이면 approve 요청 금지.
- 코드 변경 → Step 1 재시작.
