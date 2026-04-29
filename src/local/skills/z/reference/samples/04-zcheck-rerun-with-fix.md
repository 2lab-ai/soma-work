# Sample 4 — phase-3 dispatch: zcheck rerun (force fix on dodged P1)

**Purpose**: template for the orchestrator's `Agent` dispatch when a prior zcheck dodged a P0 / P1 review comment by replying "intentional design" instead of fixing it, and the user is dissatisfied. The rerun must produce an actual fix — not another rationalization.

**Subagent type**: `general-purpose`
**`run_in_background`**: `true`

---

You will rerun zcheck on PR `<PR_URL>` from the top. The previous zcheck replied to a P0 / P1 review comment with "intentional design" but the user is not satisfied. The fix is mandatory this time.

## Target
- PR: `<PR_URL>`
- Sub-issue: `<SUB_ISSUE_URL>` / Parent epic: `<EPIC_URL>`
- Worktree: `<ABSOLUTE_WORKTREE_PATH>`
- Branch: `<BRANCH_NAME>`

## Re-evaluation point

### `<P0/P1 marker>` — `<short summary of the dodged issue>`

**Situation**: `<one-paragraph statement of the bug pattern, e.g. "the handler returns BadRequest after the DB has been mutated">`.

- **Previous zcheck decision**: rationalized as intentional design (idempotent retry / half-notified avoidance / etc.).
- **Reconsider**: the **comparable adjacent code path** (cite it: `<file/function>`) does the validation **before** the DB mutation. There is no principled reason this path should differ.
  - New pattern: pre-check `<predicate>` → on failure return `BadRequest` immediately (no DB mutation).
  - Then DB mutation → if successful, proceed with publish / lifecycle update.
  - Idempotency is preserved (retries take the same path).
- **Symmetric-publish concern**: if the original code already skipped `<RoleRemove>`-style notifications when `<predicate>` failed, the new pre-check does not change that behavior — it just stops the orphan DB write.
- **Conclusion**: pre-check pattern is correct. The dodged P0 / P1 was valid. Apply the fix.

## Procedure

### Step 0: Rebase + simplify + apply the fix
1. `cd <ABSOLUTE_WORKTREE_PATH>`.
2. `git fetch origin <BASE_BRANCH> && git rebase origin/<BASE_BRANCH>` — resolve conflicts.
3. **Apply the fix** at `<file/method>`:

```<lang>
// pre-check: <predicate must hold for any side effect to be meaningful>
<List<...>?> resolved = null;
if (<condition>) {
    resolved = await <ResolveHelper>(<args>);
    if (resolved == null) {
        return <BadRequestResult>("<descriptive message>");
    }
}

// DB mutation only after pre-check passes
var (success, previousState) = await _db.<MutateAsync>(<args>);
if (!success) {
    return <NotFoundOrBadRequestResult>("<descriptive message>");
}

// publish / lifecycle update — unchanged
…
```

4. Strengthen the existing test that covered this case — add a `Verify(... Times.Never)` assertion to confirm the DB is **not** touched when the pre-check fails.
5. Reply on the dodged review thread: "fix applied — pre-check pattern (consistent with `<adjacent path>`). DB is not mutated when the pre-check fails." Then call `resolveReviewThread`.
6. Run simplify on the new diff (reuse / quality / efficiency).
7. Force-push.

### Step 1: CI re-watch (new commit re-triggers)

```bash
gh run list --branch <BRANCH_NAME> --repo <ORG>/<REPO> --limit 3 --json status,conclusion,databaseId -q '.[]'
gh run watch <id> --repo <ORG>/<REPO> --exit-status
```

### Step 2: Re-check review threads
- Confirm the previously-dodged thread is resolved.
- Process any new bot review (greptile / codex re-runs on the new commit).

### Step 3: ztrace (refreshed)
- Happy-path scenario.
- `<predicate fails>` — **DB not touched** + BadRequest (the new behavior).
- Edge case where pre-check is intentionally skipped (e.g. deactivate path).
- Post-mutation defensive (lifecycle missing → 5xx).

### Step 4 (skip — orchestrator handles user dialogue)

## Final report
- PR state.
- Fix description + commit SHA.
- CI result for both the pre-fix run and the post-fix run.
- Review thread disposition (specifically the previously-dodged thread).
- Refreshed ztrace.
- `mergeable` / `state` / `reviewDecision`.

## Hard rules
- **Do not stop midway. Do not hand back early.**
- **No "intentional design" replies** when an alternative pre-check pattern exists in adjacent code. Apply the fix.
- Worktree isolation.
- Adjacent-path consistency: the fix must mirror the verified pattern, not invent a new one.
- Sibling sub-tasks may have changed `<related file>` since the original PR — be ready for rebase conflicts and merge them carefully.
