---
name: autoz
description: "Autonomous z-pipeline driver. Triggered by `autoz` or `$autoz`. Builds SSOT-LIST + SSOT-TASK-TREE (per `local:using-ssot`), maps unknowns, runs a code-based multi-tier Analysis step with an HTML problem-analysis artifact, reproduces the instruction as a RED test, then drives the full local:using-z / local:z pipeline end-to-end without user questions. Open decisions resolve by the local:trinity consensus chain (trinity 3-engine panel → mcp__llm__chat model=codex → codex-fallback opus, each downgrade with a visible warning). A trinity-chain code review of the final PR diff is a mandatory gate before approve — the chain degrades automatically tier by tier and never approves/merges/deploys on an empty review gate. After approval, posts the SSOT success proof to the source issue and ships the final ES report as a second HTML artifact."
---

# autoz — Autonomous z-pipeline

## Trigger

- Explicit: `$autoz`, `autoz`, or `autoz <issue-url|prompt>`.
- Implicit: any instruction or issue link paired with autoz semantics ("autoz this", "autoz로 처리해줘").

## Skill Tree

autoz orchestrates; it re-implements nothing. Every phase is owned by a skill in this tree:

```
autoz
├── local:using-ssot            — SSOT contract (Hooks 1–4); shared by the whole tree
├── local:explore-unknowns      — pre-RED unknowns map (Autonomous Mode only)
├── Analysis layer (pipeline step 5 + step 15)
│   ├── stv:trace               — code-based multi-tier behavior verification
│   ├── local:structurize       — lossless structuring of the trace result
│   └── local:html              — HTML artifact rendering
│       ├── local:ui-ux (+ local:design / local:motion-design / local:apple-design)
│       │                       — design engine; `openai` named reference
│       └── local:lottie        — motion layer of the rendered page
├── local:using-z               — routing + session handoff protocol
│   └── local:z                 — controller (phase 0–5)
│       ├── superpowers:dispatching-parallel-agents — phase0 dispatch wiring
│       ├── stv:debug                 — phase0.1 bug branch
│       ├── stv:new-task              — phase1 planning
│       ├── local:decision-gate       — switching-cost tier judgment
│       │   ├── zworkflow:oracle-reviewer + subagent (opus) — 3-person majority review voters
│       │   └── local:using-epic-tasks — Case A/B/C issue/epic routing
│       │       └── local:using-ha-thinking — layer discipline for artifact bodies
│       ├── local:zwork               — implementation (RED → subagent-driven GREEN → PR)
│       │   ├── stv:verify            — spec-compliance verification loop
│       │   └── local:review-pr       — PR review pass
│       ├── local:zcheck              — post-implementation gate (CI + review comments + coverage)
│       │   ├── local:simplify        — over-engineering pass on the diff
│       │   ├── local:github-pr       — token-efficient PR data fetch
│       │   └── local:ztrace          — scenario callstack trace (single pass, Hook 4)
│       ├── local:zreflect            — drift handler (using-ssot Hook 2)
│       ├── local:UIAskUserQuestion   — interactive gates (SUPPRESSED under autoz, Rule 4)
│       └── local:es                  — terminal report (using-ssot Hook 4)
└── local:trinity chain (trinity panel → mcp__llm__chat codex → codex-fallback opus) — decision consult + mandatory review gate
```

## Hard Rules

1. **SSOT contract.** Apply `local:using-ssot` at every lifecycle hook (Intake / Drift / Resume / Report), with two autoz overrides:
   - (a) **Never pause for user confirmation** at any hook. Output the tree, then proceed — the SSOT-TASK-TREE is a visible work plan, not a question.
   - (b) **Review-chain consult is bounded** by switching cost. Skip the consult only when the operation is trivial: Intake with `ssot-task` count == 1 and depth == 1, or a Drift diff that is `added`-only with ≤ 1 node. Otherwise run the `local:trinity` chain (trinity consensus → `mcp__llm__chat` `model: codex` → `codex-fallback` opus) and log the verdict/transcript reference in the PR body. A split consult follows the same terminal as Rule 8: adopt the union of panelists' MUST-FIX as constraints, re-run the consult once; a second split is a Hard Blocker. This trivial-skip covers **SSOT-shaping consults only** — it never exempts the Rule 8 review gate.

2. **Explore → Analysis → RED, in that order, before any implementation.**
   - **Explore.** Run `local:explore-unknowns` in Autonomous Mode on the SSOT-TASK-TREE scope. The four-quadrant unknowns map is a mandatory pre-RED artifact attached to the PR body. Never enter the interactive quadrant walk — no user questions; high-risk unknown-unknowns escalate to a trinity-chain consult, never to the user. The map always carries all four quadrants — a trivial tree (1 `ssot-task`, depth 1) may compress each quadrant to a line (including explicit `none` / `closed by <file>` entries); depth shrinks, quadrants never disappear.
   - **Analysis.** Run the Analysis Step (below). Its problem-analysis artifact must exist before RED begins.
   - **RED.** Reproduce the user's intent (or the issue's described behavior) as a failing test derived from the unknowns map + analysis. Bug → the test asserts the missing/broken behavior; feature → the test pins the new behavior. **Confirm RED is actually red** by running the test and reading the output. For pure doc/skill/config changes, the RED is the existence/format/lint command that fails before the artifact exists. Every RED test must map to one or more `ssot-task` IDs.

3. **No user questions — no exceptions.** Never call `ASK_USER_QUESTION` / `UIAskUserQuestion`; never end a turn waiting for clarification. Decision points go through Rule 1(b)'s trinity-chain consult, logged in the PR body. (The former Rule 8 fallback question is gone — the review chain degrades automatically, 2026-07-16 directive.)

4. **Drive the full local:using-z / local:z pipeline, with interactive gates suppressed.** Invoke `using-z` routing first, then `z`. Honor every phase boundary (CONTINUE_SESSION handoffs included). Do not skip `zcheck`, simplify, or reviewer steps the z flow defines at the current scope. Because the z flow was written for interactive sessions, autoz replaces its user-facing gates:
   - z phase1 plan confirmation / clarification → resolved via the Rule 1(b) trinity-chain consult, logged in the PR body.
   - z phase4 / zcheck Step 4 approve question → does not fire. zcheck returns its READY verdict without prompting; the Rule 8 review gate runs; then autoz executes the approve itself (Rule 5).
   - `local:decision-gate` user-ask branches (≥ medium) → trinity-chain consult instead of `UIAskUserQuestion`; the xxlarge HALT still halts (see Hard Blockers: oversized scope — report the decomposition proposal, never ask).
   Everything else in the z flow runs unmodified.

5. **PR approval via gh CLI.** After CI is green and the Rule 8 gate passes: `gh pr review <number> --approve --body "<short rationale>"`. Do not request user approval or paste an approve URL — execute it. Run `gh pr merge` too unless repo policy (`.github/`, `CLAUDE.md`) forbids it.

6. **SSOT success proof, posted to the issue (after approve).** Render the `local:using-ssot` Hook 4 mapping — per `ssot-task`: SSOT quote → concrete artifact (PR / commit / file / test) → why the artifact satisfies the requirement — verified by the single ztrace pass Hook 4 mandates. An unmapped `ssot-task` means the run is NOT done; finish it, never write the proof around the gap. Post the proof as a comment on the source issue (`gh issue comment <n> --body-file proof.md`; bot-token 401 → the 5-retry protocol from Hard Blockers). No source issue → append the proof as the final PR-body section. The run is not finished until this evidence is posted.

7. **Terminal report only.** No mid-run progress check-ins — the only mid-run user-facing output is the SSOT-TASK-TREE (Hook 1/2) and the problem-analysis artifact. Render the terminal report via the `local:es` mode template, adding: PR URL + CI status + approve status + the Rule 6 evidence URL, review-chain verdict/round-log (or transcript) references for every autonomous decision with the tier that produced each, the Hook 4 ztrace result, the Rule 8 review verdict + tier, and the final ES report artifact (Analysis Step, artifact 2).

8. **Mandatory review gate (trinity chain, never empty).** Before `gh pr review --approve`, the final PR diff MUST receive a code review through the `local:trinity` fallback chain. Runs on **every** autoz run — "obvious", "trivial", and security must-fix changes included.
   - **Primary — `local:trinity`.** Send the full PR diff + SSOT-TASK-TREE + RED→GREEN evidence as a self-contained brief to the trinity panel and require a unanimous verdict (concrete findings, or an explicit "no blocking findings"). Log the verdict + round log in the PR body.
   - **Fallback1 — codex.** Panel cannot field 3 engines (llmux down, panel agents unavailable; 1 retry first) → emit `⚠️ TRINITY DEGRADED → fallback1 llm_chat(codex) — <reason>` and send the same payload to `mcp__llm__chat` `model: codex`. Log the transcript reference in the PR body.
   - **Fallback2 — `codex-fallback` (opus, automatic).** codex also unusable (quota, API error, timeout, empty output; retry once) → emit `⚠️ TRINITY DEGRADED → fallback2 codex-fallback(opus) — <reason>` and spawn `codex-fallback` (`Agent` tool, `subagent_type: codex-fallback`) with the **exact payload destined for codex**; treat its verdict as the review, logged in the PR body labelled `trinity-fallback2 (opus)`. This tier is automatic — no user question (2026-07-16 directive; supersedes the old opt-in contract).
   - **Fast-fail on total absence.** All three tiers failed → DO NOT approve/merge/deploy. Emit: `⚠️ REVIEW GATE UNAVAILABLE — auto-approve halted. <reason>`.
   - **Split terminal (panel valid but not unanimous after max rounds).** A split is NOT a fallback trigger — the panel stood. Treat the union of all panelists' MUST-FIX items as blocking findings, resolve them, and re-run the gate once; a second split is a Hard Blocker: stop and report the split axes (never ask, never approve on a split).
   - **Findings are blocking.** Resolve blocking findings (re-loop GREEN → zcheck → review) before approve.

## Analysis Step

Runs after Explore, before RED (pipeline step 5); its terminal counterpart runs at step 15. Purpose: verify how the system actually behaves — code-based, not assumed — and make the analysis visible before touching anything.

1. **Derive the tier surface from the project.** Identify every tier the scenario actually crosses. A chain like `backoffice UI → model → backoffice API → DB → game API → model → front → user` is an example, not a fixed list (예시일 뿐, 고정된 목록이 아니다) — reason from the actual codebase; the real project may have more or fewer tier surfaces. Derive the chain by reading entry points and call paths, never by template.
2. **Trace with `stv:trace`.** Verify the behavior across the derived tiers at callstack depth, entry point to side effect. For every data store touched, name where the data is actually stored (table / collection / key — derived from code and schema; "the DB" is not an answer) with a concrete example record. The example is **synthesized from the schema or taken from fixtures/redacted samples — never fetched from a live store and never published with live values** (PII, tokens, production data).
3. **Structurize.** Run `local:structurize` on the trace result — the analysis must be a lossless hierarchy, not a narrative.
4. **Problem-analysis artifact (HTML, artifact 1 of 2).** Render the structured analysis via `local:html` (design driven by the `ui-ux` skill with the `openai` reference): the tier-surface chain, traced callstacks, data-store locations with real examples, and the problem definition. Ship it to the thread before implementation starts.
5. **Final ES report artifact (HTML, artifact 2 of 2)** — at the terminal report, whether solved or concluded unsolvable: render the full story starting high-level and descending into every low-level detail, embedding the initial problem analysis, the resolution (or why it cannot be resolved), and the QA checklist. Two artifacts total, always — problem analysis first, final ES report last.

**Carriage across session handoffs.** When the z flow crosses a session boundary (Handoff #1), three named payload fields carry the analysis (`local:using-z` payload spec): `## Analysis Artifact` (URL), `## Analysis Summary` (structured trace summary — the only handoff section besides `## RED Mapping` where callstack-level tokens are allowed), and `## RED Mapping` (RED test → `ssot-task` IDs). `## Pipeline Mode: autoz` rides alongside so the receiving session keeps the no-question contract. The receiving zwork session **reuses and extends** the carried RED tests instead of re-authoring them, and links the artifact in the PR body. RED authorship has one owner: the intake session that ran the Analysis Step.

**HA exemption.** The two HTML artifacts are standalone drill-down documents — they are exempt from `local:es` HA layer discipline (which governs the chat-rendered ES body only). The chat ES links to the final report artifact rather than inlining its low-level detail.

## Rationale — why the review gate is mandatory

> **2026-06-23, dev2 full outage.** Security must-fix work (incl. #5006) went through autoz without a codex review (codex quota exhausted) and deployed to dev2. Every service failed to boot; recovery took a rollback, a revert, and a monitored re-deploy. An **empty review gate during autonomous deploy is a live hazard** — the trinity chain fills the review (panel, codex, or the automatic opus fallback2 — each tier logged in the PR body), or autoz stops. There is no fourth option.

## Hard Blockers (when stopping is allowed)

Stop and report — never silently fail — only when:

- Repo/branch literally cannot be accessed (auth, disk, network) **after** the 5-retry protocol: (a) different headers (Bearer↔token), (b) different tokens in env, (c) raw curl bypass, (d) alternative trigger paths (PR close+reopen, empty commit, force push), (e) a real fix attempt. "Permission insufficient" alone never justifies delegating to the user.
- The user's intent is genuinely incoherent (mutually contradictory requirements). Present the review-chain's diagnosis as a SSOT-TASK-TREE that cannot be made acyclic, not an open-ended question.
- A drift instruction retracts already-merged work and the retraction is non-revertible (e.g. a destructive migration already ran in prod) — surface the irreversibility.
- The Rule 8 gate cannot be filled: all three chain tiers failed (trinity panel, codex, codex-fallback). Report with the `⚠️ REVIEW GATE UNAVAILABLE` warning.
- Any REQUIRED trinity consult split twice (Rule 1(b) decision consult or the Rule 8 review gate): a valid panel stayed non-unanimous after max rounds, the MUST-FIX union was adopted/resolved, and the one permitted re-run split again. Report the split axes per `local:trinity` §종결 — never ask, never proceed on a split.
- **Oversized scope** — `local:decision-gate` judges the tree xxlarge (Case C). The interactive flow would ask for decomposition approval; autoz cannot ask, so it stops and reports the SSOT-TASK-TREE-based decomposition proposal (epic candidates + the `ssot-task` IDs each covers). The user relaunches per epic; autoz never starts an xxlarge tree on its own.

## Pipeline Order

1. **Hook 1 — Intake & tree.** Parse instruction / fetch link / build SSOT-LIST → SSOT-TASK-TREE → output to user → TodoWrite register → review-chain validation (Rule 1b).
2. **Scope consult (trinity chain).** Align acceptance criteria per `ssot-task`. Save verdict/transcript reference.
3. **Workspace.** Clone / locate working tree. Create branch.
4. **Explore.** `local:explore-unknowns` Autonomous Mode per Rule 2 — unknowns map into the artifact trail (PR body `<details>`).
5. **Analysis.** Analysis Step 1–4: derive tier surface → `stv:trace` → `local:structurize` → problem-analysis HTML artifact to the thread.
6. **RED.** Write RED test(s) from the unknowns map + analysis, tagged with `ssot-task` IDs. Run. Confirm RED.
7. **GREEN.** Implement until GREEN. Re-run target tests + full suite + lint + typecheck.
8. **Commit, push, open PR** — body carries scope notes, the SSOT-TASK-TREE (`ssot-subtask` layer collapsed in `<details>`), and the unknowns map (`<details>`).
9. **CI watch.** Iterate on red CI without asking — diagnose, fix, push.
10. **Self-review** with `local:zcheck`. Fix blocking findings.
11. **Drift check before approve.** New user message during 8–10 → run Hook 2 first, re-loop 6–10 as needed (refresh the step 4 map when drift widens scope).
12. **Review gate — trinity chain** (Rule 8).
13. **`gh pr review --approve`** once CI is green, zcheck is clean, and the gate is satisfied (Rule 5).
14. **SSOT success proof → issue** (Rule 6).
15. **Terminal report** (Rule 7) + final ES report HTML artifact (Analysis Step 5).

## What This Skill Does NOT Do

Beyond the Hard Rules above:

- Does not paraphrase the user's instruction when building SSOT — raw text only.
- Does not wipe-and-restart on drift — always diff at `ssot-task` granularity and resume.
- Does not shrink away the map, the Analysis, or RED for "obvious" changes — a trivial tree shrinks each artifact, it never removes one.
- Does not force-push to `main`, bypass branch protection, or skip git hooks (`--no-verify`, `--no-gpg-sign`) without explicit user authorization.
- Does not re-implement the z pipeline — it only enforces the autonomous, SSOT-first + analysis-first + RED-first, no-user-question contract on top of `local:using-z` / `local:z`.

## Relationship to Other Skills

The Skill Tree above shows structure; this table records the contracts that are not obvious from structure alone:

| Skill | Contract |
|---|---|
| `local:using-ssot` | autoz binds every Hook (1·2·3·4). Tree shape, drift diff, handoff payload, completion mapping all live there. |
| `local:explore-unknowns` | Autonomous Mode only (Rule 2). Interactive quadrant walk is forbidden inside autoz. |
| `stv:trace` / `local:structurize` / `local:html` | Analysis Step engine — trace, structure, render. `local:html` applies the `ui-ux` skill (`openai` reference) as its design engine. |
| `local:z` | z phase0 reuses the SSOT-TASK-TREE autoz built — no rebuild. autoz never re-implements z phases. |
| `local:zcheck` | Runs before approve; blocking findings must be fixed first. Its persuasion step ties findings to `ssot-task` IDs. |
| `local:decision-gate` | z phase0 runs it for tier selection (tree shape is a tier signal). autoz itself never gates on user input. |
| `local:trinity` | Consult channel for would-be user questions + the Rule 8 review gate. Chain = trinity panel → `mcp__llm__chat` (codex) → `codex-fallback` (opus); the tier that produced the verdict is logged in the PR body. |
| `mcp__llm__chat` (codex) | Fallback1 of the trinity chain — single-engine consult/review when the panel cannot field 3 engines. Transcript references logged in PR body. |
| `codex-fallback` (Opus agent) | Automatic fallback2 of the trinity chain (`src/local/agents/codex-fallback.md`), spawned when both the panel and codex are unavailable. Verdict logged as `trinity-fallback2 (opus)`. |
