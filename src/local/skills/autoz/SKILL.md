---
name: autoz
description: "Autonomous z-pipeline driver. Triggered by `autoz` or `$autoz`. Builds SSOT-LIST + SSOT-TASK-TREE first (per `local:using-ssot`), reproduces the user's instruction/issue as a RED test, confirms RED, then drives the full local:using-z / local:z procedure end-to-end without asking the user any questions. Open decisions are resolved by mutual agreement between you and codex (mcp__llm__chat model=codex). PR approval runs via `gh pr review --approve` from the gh CLI's authenticated account."
---

# autoz — Autonomous z-pipeline

## Trigger

- Explicit: `$autoz`, `autoz`, or `autoz <issue-url|prompt>`.
- Implicit: any instruction or issue link paired with autoz semantics ("autoz this", "autoz the issue", "autoz로 처리해줘").

## Hard Rules

1. **SSOT-first.** Before anything else (including RED), apply `local:using-ssot` **Hook 1** verbatim — see that skill for the canonical procedure. autoz-specific deltas:
   - (a) **Do not wait** for user confirmation after the tree is on screen. Output, then proceed.
   - (b) **Codex validation** — submit the generated tree to `mcp__llm__chat` `model: codex` to confirm every `ssot-task` traces back to a SSOT excerpt and dependencies are acyclic. **Skip the codex call when `ssot-task` count == 1 and tree depth == 1** (trivial tree, no validation value). Log the transcript reference in the PR body when called.

2. **RED-first.** After SSOT is captured, before any implementation, reproduce the user's intent (or the issue's described behavior) as a failing test.
   - Bug → test asserts the missing/broken behavior and must fail against current code.
   - Feature → test pins the new behavior and must fail because the feature isn't built yet.
   - **Confirm RED is actually red** by running the test command and reading the output. Do not proceed until RED is stable and reproducible.
   - For pure doc/skill/config additions where "test" reduces to existence/format checks, the RED is the `ls`/`cat`/lint command that fails because the artifact does not yet exist or does not yet conform. Log it.
   - Each RED test must trace back to one or more `ssot-task` IDs — record the mapping.

3. **No user questions.** Never call `ASK_USER_QUESTION` / `UIAskUserQuestion`. Never end a turn waiting for clarification. When a decision point appears (architecture, naming, scope, trade-off):
   - Call `mcp__llm__chat` with `model: codex`.
   - Use `gemini` as a tiebreaker if codex is ambiguous.
   - Codex answer + your own analysis = binding decision. Log every such decision in the PR description so the user can audit.
   - **Outputting the SSOT-TASK-TREE is not a question** — it is a visible work plan. autoz keeps running.

4. **Drift handling without asking.** If the user posts another raw instruction mid-run, apply `local:using-ssot` **Hook 2** — see that skill for the canonical procedure. autoz-specific deltas:
   - (a) **Do not pause** for confirmation between regenerating the tree and resuming.
   - (b) **Codex diff validation** — call `mcp__llm__chat` `model: codex` only when the diff touches existing topology (`changed`/`removed` non-empty) or adds ≥ 2 nodes. `added`-only with ≤ 1 node skips codex. Log the transcript reference when called.

5. **Drive the full local:using-z / local:z pipeline.** Invoke `using-z` routing first, then `z` for the actual run. Honor every phase boundary (CONTINUE_SESSION handoffs included). Do not skip `zcheck`. Do not skip simplify / oracle / reviewer steps that the z flow defines at the current scope. Session handoff payloads must carry SSOT-LIST + SSOT-TASK-TREE per `local:using-ssot` **Hook 3** so the receiving session resumes on the same tree.

6. **PR approval via gh CLI.** After CI is green and required reviews pass:
   - Run `gh pr review <number> --approve --body "<short rationale>"` from the bot's gh-authenticated shell.
   - Do not request user approval. Do not paste the approve URL — execute the approval.
   - If merge requires a separate `gh pr merge`, run it too unless project policy forbids it. Check `.github/` and `CLAUDE.md` for merge-policy hints before merging.

7. **Terminal report.** Apply `local:using-ssot` **Hook 4** via the `local:es` mode template — that template already renders the per-`ssot-task` accountability block (Requirement / Did / Why-it-satisfies). autoz-specific additions on top of `es`:
   - PR URL + CI status + approve status.
   - Codex transcript references for every autonomous decision made during the run.
   - The `ztrace` single-pass result from Hook 4 step 4 attached as the verification evidence — gaps in the ssot-task↔scenario mapping are blocking, not advisory.
   - No mid-run progress check-ins to the user. The only mid-run output is the tree visibility from Hard Rules 1 and 4.

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
