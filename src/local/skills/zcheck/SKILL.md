---
name: zcheck
description: "Post-implementation verification gate. Resolves PR review comments, ensures CI passes, then requests user approve."
---

# zcheck — Post-Implementation Verification Gate

After `local:zwork` completes, this skill ensures the PR is in a mergeable state before requesting user approval. It loops until all conditions are met.

## Input

- PR URL or `owner/repo#number`

## Process

### Step 1: Resolve All PR Review Comments

1. Fetch PR review comments via `local:github-pr`.
2. For each **unresolved** review thread:
   a. Read the comment body and the referenced code location.
   b. **If the comment is valid and code needs fixing:**
      - Fix the code
      - Commit and push
      - Reply to the comment explaining the fix
      - Resolve the thread via GraphQL API
   c. **If the comment is already addressed or not applicable:**
      - Reply with explanation of why it's resolved
      - Resolve the thread via GraphQL API
3. **Loop until 0 unresolved threads remain.**

### Step 2: CI Must Pass

1. Check CI status: `gh pr checks <PR_URL>`
2. **If pending:** Poll every 30 seconds until complete.
   ```bash
   while true; do
     status=$(gh pr checks <PR_URL> --json state -q '.[].state' | sort -u)
     if echo "$status" | grep -q "FAILURE"; then break; fi
     if echo "$status" | grep -q "PENDING"; then sleep 30; continue; fi
     if [ "$status" = "SUCCESS" ]; then break; fi
     sleep 30
   done
   ```
3. **If failed:** Use `stv:debug` to diagnose the failure and fix it. Commit and push.
4. **After any code change:** Go back to **Step 1** — new code may trigger new review comments or invalidate prior resolutions.
5. **Loop until CI is fully green.**

### Step 3: Request Approve

All review comments are resolved AND CI is green. Now ask the user.

Use `local:UIAskUserQuestion` to request approval:

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice",
      "question": "PR is ready for approval",
      "context": "▸ Review comments: N resolved, 0 remaining\n▸ CI: ✅ All checks passing\n▸ Changes: +X -Y ({N} files)\n▸ PR: {PR_URL}",
      "choices": [
        { "id": "approve", "label": "Approve & Merge", "description": "All checks pass, all comments resolved." },
        { "id": "review", "label": "I'll review manually first", "description": "Hold merge, I'll check the PR myself." }
      ]
    }
  }
}
```

## Invariants

- **Never request approve with unresolved review comments.** The user cannot approve until all threads are resolved.
- **Never request approve with failing CI.** Fix it first.
- **Every code change restarts from Step 1.** This prevents stale resolutions.

## Error Handling

- **GitHub API rate limit:** Wait and retry.
- **CI timeout (>10 min with no progress):** Report to user via `local:UIAskUserQuestion` — user may need to intervene.
- **Unresolvable review comment (e.g., requires design decision):** Use `local:decision-gate` to determine if autonomous or needs user input. If user input needed, ask via `local:UIAskUserQuestion` and wait.
