---
name: autoz
description: "Autonomous z-pipeline driver. Triggered by `autoz` or `$autoz`. Builds SSOT-LIST + SSOT-TASK-TREE first (per `local:using-ssot`), reproduces the user's instruction/issue as a RED test, confirms RED, then drives the full local:using-z / local:z procedure end-to-end without asking the user any questions. Open decisions are resolved by mutual agreement between you and codex (mcp__llm__chat model=codex). A codex code-review of the PR diff is a MANDATORY gate before approve — if codex is unavailable the default is fast-fail with a visible warning, and autoz asks the user once whether to proceed with the opt-in Opus `codex-fallback` agent as codex-substitute reviewer; it never approves/merges/deploys on an empty review gate. PR approval runs via `gh pr review --approve` from the gh CLI's authenticated account. After approval, proves success against the SSOT (using-ssot Hook 4) and posts that proof to the source issue as the evidence record of why the PR resolved it."
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
     Otherwise call `mcp__llm__chat` `model: codex` (use a `subagent (opus)` as tiebreaker if codex is ambiguous), log the transcript reference in the PR body. Report uses the ztrace single-pass result mandated by Hook 4.
     - This trivial-skip exemption covers **SSOT-shaping decision consults only**. It NEVER applies to the mandatory codex review gate in Rule 8 — the PR-diff review runs on every single run regardless of triviality.

2. **RED-first.** After SSOT is captured, before any implementation, reproduce the user's intent (or the issue's described behavior) as a failing test.
   - Bug → test asserts the missing/broken behavior and must fail against current code.
   - Feature → test pins the new behavior and must fail because the feature isn't built yet.
   - **Confirm RED is actually red** by running the test command and reading the output. Do not proceed until RED is stable and reproducible.
   - For pure doc/skill/config additions where "test" reduces to existence/format checks, the RED is the `ls`/`cat`/lint command that fails because the artifact does not yet exist or does not yet conform. Log it.
   - Each RED test must trace back to one or more `ssot-task` IDs — record the mapping.

3. **No user questions** (one exception). Never call `ASK_USER_QUESTION` / `UIAskUserQuestion`. Never end a turn waiting for clarification. Every decision point goes through Rule 1(b)'s codex consult; the consult answer + your own analysis = binding decision (logged in the PR body for audit). **The single permitted exception** is Rule 8's codex-unavailable fallback proposal: when codex cannot review, the default is fast-fail and autoz asks the user exactly once whether to proceed with the opt-in Opus `codex-fallback` agent. That one safety question is allowed precisely because the dev2 outage proved silent no-review progression is the worse failure.

4. **Drive the full local:using-z / local:z pipeline.** Invoke `using-z` routing first, then `z` for the actual run. Honor every phase boundary (CONTINUE_SESSION handoffs included). Do not skip `zcheck`. Do not skip simplify / oracle / reviewer steps that the z flow defines at the current scope.

5. **PR approval via gh CLI.** After CI is green and required reviews pass:
   - Run `gh pr review <number> --approve --body "<short rationale>"` from the bot's gh-authenticated shell.
   - Do not request user approval. Do not paste the approve URL — execute the approval.
   - If merge requires a separate `gh pr merge`, run it too unless project policy forbids it. Check `.github/` and `CLAUDE.md` for merge-policy hints before merging.

6. **SSOT success proof, posted to the issue (mandatory, after approve).** Prove — against the SSOT, not the work narrative — *why* the run succeeded, then write that proof into the source issue:
   - Render the `local:using-ssot` Hook 4 mapping: per `ssot-task`, quote the SSOT sentence it came from → the concrete artifact (PR / commit / file / test) → the causal reason the artifact satisfies the requirement. Verify with the single ztrace pass mandated by Hook 4. An unmapped `ssot-task` means the run is NOT done — go back and finish; never write the proof around the gap.
   - Post the proof as a comment on the source issue: `gh issue comment <number> --body-file <proof.md>` (bot-token 401 → the 5-retry protocol from Hard Blockers, raw curl included). This comment is the evidence record of **why this PR resolved this issue** — SSOT quote → what was done → why that satisfies it, plus RED→GREEN evidence and the PR link.
   - If the run started from a plain instruction with no issue, append the proof as the final section of the PR body instead.
   - The run is not finished until this evidence is posted.

7. **Terminal report only.** Render via the `local:es` mode template (which already implements Hook 4's per-`ssot-task` accountability block). autoz-specific additions on top of `es`:
   - PR URL + CI status + approve status + the evidence URL from Rule 6 (issue-comment URL preferred; the PR-body proof section URL on the no-issue fallback).
   - Codex transcript references for every autonomous decision.
   - The single ztrace pass result from Hook 4 attached as verification evidence — unmapped `ssot-task` is blocking, not advisory.
   - No mid-run progress check-ins. The only mid-run user-facing output is the SSOT-TASK-TREE visibility mandated by Hook 1 / Hook 2.

8. **Mandatory codex review gate (fast-fail, never empty).** Before `gh pr review --approve`, the final PR diff MUST receive a code review from codex. This gate is non-negotiable and runs on **every** autoz run — including "obvious", "trivial", and security must-fix changes. The Rule 1(b) trivial-skip covers SSOT-shaping consults only; it never exempts this review.
   - **Primary — codex.** Send the full PR diff + the SSOT-TASK-TREE + the RED→GREEN evidence to `mcp__llm__chat` `model: codex` and require an actual review verdict (concrete findings, or an explicit "no blocking findings"). Log the transcript reference in the PR body.
   - **Fast-fail on absence.** If codex does not return a usable review — usage/quota exhausted, API error, timeout, or empty/garbage output — DO NOT proceed to approve / merge / deploy. Halt the autonomous progression immediately and emit a visible warning in the run output:
     `⚠️ CODEX REVIEW UNAVAILABLE — auto-approve halted. <reason>`.
     Silently continuing past an empty review gate is the exact failure that took dev2 down (see Rationale). It is forbidden.
   - **Default = fast-fail. The Opus fallback is opt-in, never automatic.** Attempt exactly one codex recovery retry. If codex still cannot produce a review, the default is to STOP here — do NOT auto-substitute another model. As a deliberate, narrow exception to Hard Rule 3, autoz PROPOSES the fallback to the user exactly once via `UIAskUserQuestion`: *"codex review unavailable — proceed with the Opus codex-substitute agent (`codex-fallback`) instead, or stop?"*
     - **User declines / does not approve** → the fast-fail stands: stop and report (Hard Blocker). Never approve / merge / deploy.
     - **User approves** → spawn the **`codex-fallback` Opus agent** (`Agent` tool, `subagent_type: codex-fallback`) and hand it the **exact review payload that was destined for codex** — the same PR diff, SSOT-TASK-TREE, RED→GREEN evidence, and review instructions. Treat its verdict as the codex-equivalent review for this run. Log it in the PR body labelled `codex-substitute (opus)` so the audit trail shows the gate was *filled by the user-approved fallback*, not skipped.
   - **Hard stop if neither path produces a review.** If codex is unavailable and the user declined the Opus fallback (or the `codex-fallback` agent itself cannot review), this is a Hard Blocker — stop and report. Never approve, merge, or deploy on an empty review gate.
   - **Findings are blocking.** Blocking findings from whichever reviewer filled the gate must be resolved (re-loop GREEN → zcheck → review) before approve, exactly like zcheck blocking findings.

## Rationale — why the review gate is mandatory

> **2026-06-23, dev2 full outage.** Security must-fix work (incl. #5006) was run through autoz auto-mode **without a codex review** (codex usage was exhausted) and deployed to dev2. Every dev2 service failed to boot — `EndpointRoutingMiddleware` `LazyInitializer` exception, crash during routing-initialization. Recovery took a full rollback, a further `#5006` revert, and monitored re-deploy until `qa-dev2` passed.
>
> Lesson: an **empty review gate during autonomous deploy is a live hazard**, not a theoretical one. autoz must never trade the review gate for "codex is down right now." Either codex reviews it, or an Opus subagent fills the gate, or autoz stops — there is no fourth option that proceeds.

## Hard Blockers (when stopping is allowed)

Stop and report — do not silently fail — only when:

- Repo / branch literally cannot be accessed (auth, disk, network) **after** the 5-retry-strategy protocol from your memory: (a) different headers (Bearer↔token), (b) different tokens in env, (c) raw curl bypass, (d) alternative trigger paths (PR close+reopen, empty commit, force push), (e) a real fix attempt. "Permission insufficient" alone is never enough to delegate to the user.
- User's intent is genuinely incoherent (mutually contradictory requirements). Even then, present codex's diagnosis of the contradiction as a SSOT-TASK-TREE that cannot be made acyclic, not an open-ended question.
- Drift instruction explicitly retracts work that has already been merged and the retraction is non-revertible (e.g. a destructive migration already ran in prod) — surface the irreversibility, do not silently re-do.
- The mandatory review gate (Rule 8) cannot be filled: codex is unrecoverable AND the user declined the Opus fallback (or the `codex-fallback` agent itself cannot review). Report with the `⚠️ CODEX REVIEW UNAVAILABLE` warning. Never approve/merge/deploy to fill the gap.

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
10. **Mandatory codex review gate (Hard Rule 8).** Submit the final PR diff to codex for code review. On codex absence: emit the `⚠️ CODEX REVIEW UNAVAILABLE` warning, retry once, and if still down the default is **fast-fail** — then ask the user once whether to proceed with the opt-in Opus `codex-fallback` agent (fed the exact codex review payload). Resolve blocking findings before continuing. The gate must be filled by codex or the user-approved Opus substitute — otherwise stop (Hard Blocker).
11. **`gh pr review --approve`** once green, zcheck is clean, AND the Rule 8 review gate is satisfied.
12. **SSOT success proof → issue update.** Build the Hook 4 per-`ssot-task` proof (ztrace-verified) and post it to the source issue as the why-this-PR-resolved-it record (Hard Rule 6).
13. **Terminal report.** Hook 4. Includes `ztrace` cross-check + the Rule 6 evidence URL (issue comment, or PR-body proof section when no issue) + the Rule 8 review-gate verdict and reviewer (`codex` or `codex-substitute (opus)`).

## What This Skill Does NOT Do

- Does not skip the SSOT-TASK-TREE intake/output (Hook 1) even for "obvious" one-line changes.
- Does not paraphrase the user's instruction when building SSOT — raw text only.
- Does not wipe-and-restart on drift. Always diff at `ssot-task` granularity and resume.
- Does not skip the RED phase even for "obvious" changes.
- Does not approve PRs with unresolved review comments or red CI.
- Does not approve / merge / deploy on an empty review gate. A codex review (or the Opus-subagent codex-substitute when codex is unrecoverable) is mandatory on every run — codex unavailability fast-fails with a visible warning, it never silently skips the review (Rule 8).
- Does not end the run without the SSOT success proof posted to the source issue (or PR body when no issue exists).
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
| `mcp__llm__chat` (codex) | Sole consultation channel when a decision would otherwise become a user question. Used for SSOT-TASK-TREE validation, scope alignment, drift-diff justification, tie-break decisions, **and the mandatory pre-approve code-review gate (Rule 8)**. Transcript references must be logged in PR body. |
| `codex-fallback` (Opus agent) | Opt-in codex-substitute reviewer for Rule 8 (`src/local/agents/codex-fallback.md`). Spawned **only** when codex is unrecoverable AND the user approved the fallback at autoz's one permitted question. Receives the exact review payload destined for codex and fills the mandatory review gate. Verdict logged in the PR body labelled `codex-substitute (opus)`. Default on codex failure remains fast-fail. |
