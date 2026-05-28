---
name: autoz
description: "Autonomous z-pipeline driver. Triggered by `autoz` or `$autoz`. Builds SSOT-LIST + SSOT-TASK-TREE first (per `local:using-ssot`), reproduces the user's instruction/issue as a RED test, confirms RED, then drives the full local:using-z / local:z procedure end-to-end without asking the user any questions. Open decisions are resolved by mutual agreement between you and codex (mcp__llm__chat model=codex). PR approval runs via `gh pr review --approve` from the gh CLI's authenticated account."
---

# autoz — Autonomous z-pipeline

## Trigger

- Explicit: `$autoz`, `autoz`, or `autoz <issue-url|prompt>`.
- Implicit: any instruction or issue link paired with autoz semantics ("autoz this", "autoz the issue", "autoz로 처리해줘").

## Hard Rules

1. **SSOT contract.** Apply `local:using-ssot` at every lifecycle hook (Intake / Drift / Resume / Report). autoz-specific overrides:
   - (a) **Never pause for user confirmation** at any hook. Output the tree, then proceed. Outputting the SSOT-TASK-TREE is not a question — it's a visible work plan.
   - (b) **Codex consult is bounded** by switching cost. Skip codex when the operation is trivial:
     - Intake — tree has `ssot-task` count == 1 AND depth == 1.
     - Drift — diff is `added`-only AND adds ≤ 1 node AND no `changed`/`removed`.
     Otherwise call `mcp__llm__chat` `model: codex` (use `gemini` as tiebreaker), log the transcript reference in the PR body. Report uses the ztrace single-pass result mandated by Hook 4.

2. **RED-first.** After SSOT is captured, before any implementation, reproduce the user's intent (or the issue's described behavior) as a failing test.
   - Bug → test asserts the missing/broken behavior and must fail against current code.
   - Feature → test pins the new behavior and must fail because the feature isn't built yet.
   - **Confirm RED is actually red** by running the test command and reading the output. Do not proceed until RED is stable and reproducible.
   - For pure doc/skill/config additions where "test" reduces to existence/format checks, the RED is the `ls`/`cat`/lint command that fails because the artifact does not yet exist or does not yet conform. Log it.
   - Each RED test must trace back to one or more `ssot-task` IDs — record the mapping.

3. **No user questions.** Never call `ASK_USER_QUESTION` / `UIAskUserQuestion`. Never end a turn waiting for clarification. Every decision point goes through Rule 1(b)'s codex consult; the consult answer + your own analysis = binding decision (logged in the PR body for audit).

4. **Drive the full local:using-z / local:z pipeline.** Invoke `using-z` routing first, then `z` for the actual run. Honor every phase boundary (CONTINUE_SESSION handoffs included). Do not skip `zcheck`. Do not skip simplify / oracle / reviewer steps that the z flow defines at the current scope.

5. **PR approval via gh CLI.** After CI is green and required reviews pass:
   - Run `gh pr review <number> --approve --body "<short rationale>"` from the bot's gh-authenticated shell.
   - Do not request user approval. Do not paste the approve URL — execute the approval.
   - If merge requires a separate `gh pr merge`, run it too unless project policy forbids it. Check `.github/` and `CLAUDE.md` for merge-policy hints before merging.

6. **Terminal report only.** Render via the `local:es` mode template (which already implements Hook 4's per-`ssot-task` accountability block). autoz-specific additions on top of `es`:
   - PR URL + CI status + approve status.
   - Codex transcript references for every autonomous decision.
   - The single ztrace pass result from Hook 4 attached as verification evidence — unmapped `ssot-task` is blocking, not advisory.
   - No mid-run progress check-ins. The only mid-run user-facing output is the SSOT-TASK-TREE visibility mandated by Hook 1 / Hook 2.

## Hard Blockers (when stopping is allowed)

Stop and report — do not silently fail — only when:

- Repo / branch literally cannot be accessed (auth, disk, network) **after** the 5-retry-strategy protocol from your memory: (a) different headers (Bearer↔token), (b) different tokens in env, (c) raw curl bypass, (d) alternative trigger paths (PR close+reopen, empty commit, force push), (e) a real fix attempt. "Permission insufficient" alone is never enough to delegate to the user.
- User's intent is genuinely incoherent (mutually contradictory requirements). Even then, present codex's diagnosis of the contradiction as a SSOT-TASK-TREE that cannot be made acyclic, not an open-ended question.
- Drift instruction explicitly retracts work that has already been merged and the retraction is non-revertible (e.g. a destructive migration already ran in prod) — surface the irreversibility, do not silently re-do.

## Pipeline Order

1. **Hook 1 — Intake & tree.** Parse instruction / fetch link / build SSOT-LIST → SSOT-TASK-TREE → output to user → TodoWrite register → codex validation.
2. **Codex scope consult.** Align on acceptance criteria per `ssot-task`. Save transcript reference.
3. **Workspace.** Clone / locate working tree. Create branch.
4. **RED.** Write RED test(s), tag each with the `ssot-task` IDs it covers. Run. Confirm RED.
5. **GREEN.** Implement until GREEN. Re-run target tests + full test suite + lint + typecheck.
6. **Commit, push, open PR** with codex-decided scope notes + the SSOT-TASK-TREE rendered in the PR body (collapsed `<details>` for the `ssot-subtask` layer).
7. **CI watch.** Iterate on red CI without asking user — diagnose, fix, push.
8. **Self-review** with `local:zcheck`. Address blocking findings.
9. **Drift check before approve.** If a new user message arrived during 6–8, run Hook 2 first and re-loop 4–8 as needed.
10. **`gh pr review --approve`** once green and zcheck is clean.
11. **Terminal report.** Hook 4. Includes `ztrace` cross-check.

## What This Skill Does NOT Do

- Does not skip the SSOT-TASK-TREE intake/output (Hook 1) even for "obvious" one-line changes.
- Does not paraphrase the user's instruction when building SSOT — raw text only.
- Does not wipe-and-restart on drift. Always diff at `ssot-task` granularity and resume.
- Does not skip the RED phase even for "obvious" changes.
- Does not approve PRs with unresolved review comments or red CI.
- Does not force-push to `main`, does not bypass branch protection, does not skip git hooks (`--no-verify`, `--no-gpg-sign`, etc.) unless the user has explicitly authorized it.
- Does not re-implement the z pipeline. It only enforces the autonomous, SSOT-first + RED-first, no-user-question contract on top of `local:using-z` / `local:z`.

## Relationship to Other Skills

| Skill | Relationship |
|---|---|
| `local:using-ssot` | **autoz binds every Hook (1·2·3·4) to this contract.** The SSOT-TASK-TREE shape, drift diff, handoff payload, and completion mapping all live there. |
| `local:using-z` | autoz delegates routing to `using-z` once the SSOT-TASK-TREE is on screen. Session handoffs carry SSOT-LIST + tree. |
| `local:z` | autoz hands off implementation/CI/review to `z` and never re-implements those phases. z phase0 reuses the SSOT-TASK-TREE autoz built rather than rebuilding. |
| `local:zcheck` | autoz calls `zcheck` before approval. Blocking findings must be fixed before `gh pr review --approve`. zcheck's persuasion step ties findings back to `ssot-task` IDs. |
| `local:ztrace` | autoz's terminal report cross-checks the SSOT-TASK-TREE coverage against ztrace scenarios. |
| `local:es` | autoz's terminal report uses the `es` mode template, with the SSOT-TASK-TREE walk as the body. |
| `local:decision-gate` | autoz lets `z` phase0 run `decision-gate` for tier selection (tree depth/breadth is one of the tier signals). autoz itself does not gate on user input. |
| `mcp__llm__chat` (codex) | Sole consultation channel when a decision would otherwise become a user question. Used for SSOT-TASK-TREE validation, scope alignment, drift-diff justification, tie-break decisions. Transcript references must be logged in PR body. |
