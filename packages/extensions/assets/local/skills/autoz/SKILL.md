---
name: autoz
description: "Autonomous z-pipeline driver. Triggered by `autoz` or `$autoz`. Reproduce the user's instruction/issue as a RED test first, confirm RED, then drive the full local:using-z / local:z procedure end-to-end without asking the user any questions. Open decisions are resolved by mutual agreement between you and codex (mcp__llm__chat model=codex). PR approval runs via `gh pr review --approve` from the gh CLI's authenticated account."
---

# autoz — Autonomous z-pipeline

## Trigger

- Explicit: `$autoz`, `autoz`, or `autoz <issue-url|prompt>`.
- Implicit: any instruction or issue link paired with autoz semantics ("autoz this", "autoz the issue", "autoz로 처리해줘").

## Hard Rules

1. **RED-first.** Before any implementation, reproduce the user's intent (or the issue's described behavior) as a failing test.
   - Bug → test asserts the missing/broken behavior and must fail against current code.
   - Feature → test pins the new behavior and must fail because the feature isn't built yet.
   - **Confirm RED is actually red** by running the test command and reading the output. Do not proceed until RED is stable and reproducible.
   - For pure doc/skill/config additions where "test" reduces to existence/format checks, the RED is the `ls`/`cat`/lint command that fails because the artifact does not yet exist or does not yet conform. Log it.

2. **No user questions.** Never call `ASK_USER_QUESTION` / `UIAskUserQuestion`. Never end a turn waiting for clarification. When a decision point appears (architecture, naming, scope, trade-off):
   - Call `mcp__llm__chat` with `model: codex`.
   - Use `gemini` as a tiebreaker if codex is ambiguous.
   - Codex answer + your own analysis = binding decision. Log every such decision in the PR description so the user can audit.

3. **Drive the full local:using-z / local:z pipeline.** Invoke `using-z` routing first, then `z` for the actual run. Honor every phase boundary (CONTINUE_SESSION handoffs included). Do not skip `zcheck`. Do not skip simplify / oracle / reviewer steps that the z flow defines at the current scope.

4. **PR approval via gh CLI.** After CI is green and required reviews pass:
   - Run `gh pr review <number> --approve --body "<short rationale>"` from the bot's gh-authenticated shell.
   - Do not request user approval. Do not paste the approve URL — execute the approval.
   - If merge requires a separate `gh pr merge`, run it too unless project policy forbids it. Check `.github/` and `CLAUDE.md` for merge-policy hints before merging.

5. **Terminal report only.** End the run with one terminal message containing:
   - PR URL
   - What was changed (1–3 bullets)
   - Key decisions made without user input (with codex transcript reference or quote)
   - Test evidence (RED → GREEN snippets)
   - CI status
   - Approve status
   - No mid-run progress check-ins to the user.

## Hard Blockers (when stopping is allowed)

Stop and report — do not silently fail — only when:

- Repo / branch literally cannot be accessed (auth, disk, network) **after** the 5-retry-strategy protocol from your memory: (a) different headers (Bearer↔token), (b) different tokens in env, (c) raw curl bypass, (d) alternative trigger paths (PR close+reopen, empty commit, force push), (e) a real fix attempt. "Permission insufficient" alone is never enough to delegate to the user.
- User's intent is genuinely incoherent (mutually contradictory requirements). Even then, present codex's diagnosis of the contradiction, not an open-ended question.

## Pipeline Order

1. Parse instruction / fetch issue (`gh issue view`).
2. Codex consult to align on scope + acceptance criteria. Save transcript reference.
3. Clone / locate working tree. Create branch.
4. Write RED test. Run it. Confirm RED.
5. Implement until GREEN. Re-run test.
6. Run full test suite + lint + typecheck.
7. Commit, push, open PR with codex-decided scope notes.
8. Watch CI. Iterate on red CI without asking user — diagnose, fix, push.
9. Self-review with `local:zcheck`. Address blocking findings.
10. `gh pr review --approve` once green.
11. Terminal report.

## What This Skill Does NOT Do

- Does not skip the RED phase even for "obvious" changes.
- Does not approve PRs with unresolved review comments or red CI.
- Does not force-push to `main`, does not bypass branch protection, does not skip git hooks (`--no-verify`, `--no-gpg-sign`, etc.) unless the user has explicitly authorized it.
- Does not re-implement the z pipeline. It only enforces the autonomous, RED-first, no-user-question contract on top of `local:using-z` / `local:z`.

## Relationship to Other Skills

| Skill | Relationship |
|---|---|
| `local:using-z` | autoz delegates routing to `using-z` once intent is parsed. |
| `local:z` | autoz hands off implementation/CI/review to `z` and never re-implements those phases. |
| `local:zcheck` | autoz calls `zcheck` before approval. Blocking findings must be fixed before `gh pr review --approve`. |
| `local:decision-gate` | autoz lets `z` phase0 run `decision-gate` for tier selection. autoz itself does not gate on user input. |
| `mcp__llm__chat` (codex) | Sole consultation channel when a decision would otherwise become a user question. Transcript reference must be logged in PR body. |
