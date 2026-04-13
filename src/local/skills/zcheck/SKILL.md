---
name: zcheck
description: "Post-implementation verification gate. Resolves PR review comments, ensures CI passes, then requests user approve."
---

# zcheck — Post-Implementation Verification Gate

PR이 mergeable 상태가 될 때까지 루프. **코드 변경 시 Step 1부터 재시작.**

## Input

- PR URL or `owner/repo#number`

## Step 1: Resolve All PR Review Comments

1. `local:github-pr`로 리뷰 코멘트 가져오기.
2. Unresolved 쓰레드마다: 코드 확인 → 수정 필요시 fix+commit+push+reply+resolve, 이미 해결됐으면 reply+resolve.
3. 0 unresolved까지 루프.

## Step 2: CI Must Pass

**`gh pr checks` 사용 금지** — bot 토큰에서 GraphQL `statusCheckRollup` 권한 부족으로 실패함.

```bash
# Actions API 사용
gh run list --branch <BRANCH> --repo <OWNER/REPO> --limit 1 --json status,conclusion,databaseId -q '.[0]'
```

- **in_progress:** 30초마다 폴링.
- **failed:** `gh run view <RUN_ID> --log-failed`로 진단 → fix → commit+push → **Step 1로 복귀**.
- **success:** Step 3으로.

## Step 3: Request Approve


1. 유저애게 이슈와 approve를 요청할 PR 링크를 보낸다
`local:UIAskUserQuestion`으로 approve 요청. 리뷰 코멘트 해결 수, CI 상태, 변경 범위를 보낸다.
 
## Invariants

- Unresolved 코멘트 있으면 approve 요청 금지.
- CI 실패 중이면 approve 요청 금지.
- 코드 변경 → Step 1 재시작.
