# Sample 4 — phase-3 dispatch: zcheck rerun (force fix on a dodged P0 / P1)

**When to use this template**: a prior phase-3 gate-driver subagent replied "intentional design" to a Greptile / Codex P0 or P1 instead of applying a fix, the user has rejected the rationalization, and the orchestrator is dispatching a fresh subagent to actually fix it.

**Subagent type**: `general-purpose`
**`run_in_background`**: `true`

This file has two parts:

1. **§Abstract Pattern** — the reusable template the orchestrator fills in for any "rerun must fix" case. Copy this for new dispatches.
2. **§Worked Example** — one concrete fill-in (DB-mutation-before-validation case) showing what each `<…>` slot looks like in practice. Reference only; do not copy the worked-example wording into a real dispatch.

---

## §Abstract Pattern

You will rerun the phase-3 gate on PR `<PR_URL>` from Step 0. The previous gate replied to `<P0/P1 marker>` with `<rationalization>` and the user has rejected that. **The fix is mandatory this round; another rationalization is not acceptable.**

### Target
- PR: `<PR_URL>`
- Sub-issue: `<SUB_ISSUE_URL>` / Parent epic: `<EPIC_URL>`
- Worktree: `<ABSOLUTE_WORKTREE_PATH>`
- Branch: `<BRANCH_NAME>`
- Base: `<BASE_BRANCH>`

### Re-evaluation point
- **Issue**: `<one-line summary of the dodged review comment — what behavior is wrong>`.
- **Previous rationalization**: `<the specific argument the prior gate made — quote it>`.
- **Why the rationalization fails**: `<adjacent code path / invariant / contract that already does the right thing — cite the file/function>`. Adjacent-path consistency is the rule: if `<adjacent path>` enforces `<predicate>` before `<side effect>`, this path must too.
- **Correct fix shape**: `<one or two sentences describing the structural fix — pre-check, validation move, ordering swap, etc.>`.

### Procedure

#### Step 0 — rebase + apply fix + push
1. `cd <ABSOLUTE_WORKTREE_PATH>`.
2. `git fetch origin <BASE_BRANCH> --quiet && git rebase origin/<BASE_BRANCH>` — handle conflicts.
3. Apply the structural fix at `<file/method>` per the §Re-evaluation point shape.
4. Strengthen the test that covers this case: add an assertion that the previously-orphan side effect is now skipped on failure (e.g. `Verify(... Times.Never)` for a mock, or a state-not-mutated assertion for an integration test).
5. Reply on the dodged review thread: a behavior-level explanation citing the adjacent path. Then call `resolveReviewThread`.
6. Run `simplify` against the new diff.
7. `git push --force-with-lease origin <BRANCH_NAME>` (raw `--force` is forbidden).
8. Re-read `gh pr view <NUM> --json reviewDecision,mergeable,state` — record post-rebase `reviewDecision` for the final report.

#### Step 1 — CI re-watch (new commit re-triggers)
```bash
gh run list --branch <BRANCH_NAME> --repo <ORG>/<REPO> --limit 3 --json status,conclusion,databaseId -q '.[]'
gh run watch <id> --repo <ORG>/<REPO> --exit-status
```
Failure → diagnose → fix → push → restart Step 1.

#### Step 2 — re-check review threads
- Confirm the previously-dodged thread is resolved.
- Process any new bot review (greptile / codex re-runs on the new commit). P0 / P1 → fix → push → restart Step 1.

#### Step 3 — ztrace (refreshed)
- Happy-path scenario.
- The previously-broken scenario (`<predicate fails>`) — now produces the correct behavior (`<expected terminal state>`).
- Edge case where the pre-check / validation is intentionally skipped (e.g. a no-op variant).
- Post-mutation defensive scenarios.

#### Step 4 (skip — orchestrator handles user dialogue)

### Final report
- PR state.
- Fix description + commit SHA.
- CI result for both the pre-fix run and the post-fix run.
- Review thread disposition (specifically the previously-dodged thread + the resolve-mutation outcome).
- Refreshed ztrace.
- Post-rebase `reviewDecision` / `mergeable` / `state`.

### Hard rules
- **Do not stop midway. Do not hand back early.**
- **No "intentional design" replies** when an alternative pattern exists in adjacent code. Apply the fix.
- Worktree isolation — never modify the orchestrator's directory.
- Adjacent-path consistency: the fix must mirror the verified pattern, not invent a new one.
- Sibling sub-tasks may have touched `<related files>` since the original PR — be ready for rebase conflicts and merge carefully.
- `--force-with-lease` only. Subagent does **not** call `UIAskUserQuestion` / `decision-gate` UI.

---

## §Worked Example (reference only — do not copy verbatim)

The following is one concrete case the abstract pattern was extracted from. Use it to see how the slots get filled; **do not copy this wording into a new dispatch** — fill the abstract template with the new case's specifics.

- **`<P0/P1 marker>`** = `Greptile P1 — handler mutates DB then returns BadRequest`
- **`<rationalization>`** = "intentional design — idempotent retry, half-notified avoidance"
- **Adjacent path** = the activate handler in the same service runs `ResolveTargetByRoleAsync` **before** any DB mutation; if that returns null it returns `BadRequest` and the DB is untouched. The change-role handler being audited skips this pre-check, mutates the row, then returns `BadRequest` if the new role has no agent — leaving an orphan DB write.
- **Correct fix shape** = pre-check the resolver in change-role too, returning `BadRequest` before the mutation. Idempotency is preserved (retries hit the same pre-check). The downstream `RoleRemove` notification was already skipped on the failure path, so notification symmetry is unchanged.
- **Test strengthening** = the existing `ChangeRole_NoAgentForNewRole_ReturnsBadRequest` case adds `_dbMock.Verify(d => d.ChangeDomainRoleAsync(...), Times.Never)` to pin the new "DB untouched" invariant.

That is one case. The pattern generalizes to any "side effect happens before validation" bug; the abstract template above is what the orchestrator fills in for the next instance.
