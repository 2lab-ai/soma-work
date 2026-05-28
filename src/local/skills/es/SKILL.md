---
name: es
description: "Trigger: when local:zwork completes, or at turn-end via the harness. Routes to a tiered (brief / issue / epic) Executive Summary by work volume, mirroring using-epic-tasks Case A/B/C but for the report layer."
---

# Executive Summary (`local:es`) — tiered router

After work completion (or at turn-end), produce an Executive Summary that lets stakeholders **make their next decision from this single document**.

This skill is tiered. Three modes, picked by **actual artifact scope of this session**, not by request size:

| Mode | When | Equivalent in `using-epic-tasks` | Implementation detail allowed? |
|---|---|---|---|
| `brief` | No PR/issue produced this turn. Q&A, exploration, single-file edits, clarification. | (none — under Case A escape) | Yes, lightly (in "Key Details") |
| `issue` | One durable unit: 1 issue, 1 PR, 1 branch. Sub-issue of an epic counts here. | Case A | **Yes — encouraged** |
| `epic` | Multiple PRs, multi-issue work, root-cause analysis, STV verify cycle. | Case B | **No — link out to sub-issues/PRs** (HA discipline) |

The **top of every mode** carries the same invariant: SSOT (user's request verbatim) → Status (issue/PR links + state changes) → **SSOT-TASK-TREE result** (per-`ssot-task` accountability). The user's hard requirement that "what was done — issue handling, PR links, status changes — sits at the very top" is satisfied by this three-section top of document.

Per `local:using-ssot` **Hook 4**, the SSOT-TASK-TREE result section is mandatory in all three modes. It is the link between "what the user asked for" (SSOT-LIST) and "what was actually delivered" (artifacts). Without it, completion reports drift into narrative.

## Mode resolution

### Path B — invoked by the harness at turn-end

The harness (`src/slack/summary-service.ts`) computes the mode from session state via `selectExecutiveSummaryMode(session)` and injects it into the prompt as

```
Active ES mode: <brief|issue|epic> (host-selected; do not reclassify)
```

When you (the LLM) see this header, **trust it**. Do not second-guess. The host knows `links.pr`, `linkHistory.prs`, `linkHistory.issues`, `workflow`, and `handoffContext.parentEpicUrl` directly — the conversation transcript does not.

### Path A — invoked manually after `local:zwork` or by `$es`

You don't have a host hint. Self-classify using this discovery procedure:

1. `git status --porcelain` and `git log --oneline @{upstream}..HEAD` (if upstream exists) — count session-local commits.
2. `gh pr status --json url,state,title,number` — count PRs touched.
3. `gh issue list --search "involves:@me updated:>=YYYY-MM-DD" --json url,state,title,number` (scoped to this session window) — count issues.
4. Look for STV verify or root-cause language anywhere in the conversation (`stv:verify`, "root cause", "fix history") — any hit upgrades toward `epic`.

Decision rule (apply top to bottom, first match wins):

- `≥2 PRs touched` **or** `≥2 issues touched` **or** STV verify ran **or** workflow was `z-epic-update` → **`epic`**
- `1 PR touched` **or** `1 issue touched` → **`issue`**
- otherwise → **`brief`**

**Default-down**: when commands fail or evidence is ambiguous, pick the lower mode. An over-padded `epic` document is worse than a clean `issue` one.

## Writing procedure

1. Determine mode (Path B: read the host header; Path A: run discovery).
2. Read `reference/templates/<mode>.md` — that is the mode's section spec.
3. Read the legacy reference `reference/executive-summary-template.md` + `reference/executive-summary-example.md` if more detail is needed for the `epic` tier — they remain as conceptual reference, not as canonical templates.
4. Collect concrete artifacts from the conversation (links + state + files + commands + commits + outcomes).
5. Write the summary following the mode template. Respect the language of the conversation.

## Global rules (apply at every mode)

- **No table-only listings** — every section is connected with narrative, even at `brief`.
- **Include all issue/PR links with current state** — `Open / Draft / Merged / Closed / QA / etc.`.
- **Quote the user verbatim** in SSOT — never paraphrase, summarize, or "clean up".
- **Concrete artifacts, no abstractions** — `src/foo.ts:42`, command names, PR numbers, commit hashes. Never invent values you did not see.
- **Omit sections that have nothing to report** — do not fabricate, do not hedge.
- **Same language as the conversation** — Korean session ⇒ Korean ES.
- **No tool calls when run as one-shot fork** (Path B). When run manually as Path A you may use `git` / `gh` for discovery only.

## HA discipline (binding from `using-ha-thinking`)

A sentence at one mode must close without using terms from the mode below.

- `epic` body talks about issues, PRs, statuses, architectural outcomes — never file paths or function names.
- `issue` body talks about files, commands, commits, tests — never inflates into multi-PR / workstream tables.
- `brief` body talks about answers / outcomes — never invents the artifacts of a higher mode.

Violating this is the most common reason an `epic` ES degenerates into a 4-page `issue` ES with the wrong wrapper.

## Anti-patterns

- Empty Status section at `brief` (codex round 3: empty Status trains readers to skip the top).
- File paths inside `epic` body (HA leak).
- "Decisions Made" inferred from descriptive language (fabrication).
- Mode downgrade on a quiet turn (`brief` after `issue` overwriting the prior summary — host stickiness must prevent this, but the LLM must also not request a downgrade).
- Restating SSOT in your own words.

## Integration

- **Path A entry**: `local:zwork` exit → `local:es` (this skill) → `local:zcheck` post-gate.
- **Path B entry**: `src/slack/pipeline/stream-executor.ts` `onSummaryTimerFire` → `SummaryService.execute` → forked one-shot using this skill's templates inlined in the prompt.
- **Sister skills**: `using-ssot` (SSOT-TASK-TREE source of truth — every mode renders the tree result), `using-ha-thinking` (layer discipline), `using-epic-tasks` (planning-side Case A/B/C), `decision-gate` (switching-cost tiers).
- **Legacy references** (kept, not deleted): `reference/executive-summary-template.md`, `reference/executive-summary-example.md`. These cover the previous fixed 8-section format and serve as the conceptual ancestor of the current `epic` template.
