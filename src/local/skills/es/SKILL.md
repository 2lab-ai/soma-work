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

The **top of every mode** carries the same invariant: TL;DR (3 lines, a ⚠️ line when an own artifact is unfinished) → SSOT (user's request verbatim) → Status (issue/PR/document links + state changes, own artifacts marked) → **SSOT-TASK-TREE result** (per-`ssot-task` accountability). The **bottom of every mode** is fixed too: when an own issue/PR is not complete, the last section is `⚠️ User follow-up required` (see [Unfinished own artifacts](#unfinished-own-artifacts)). The user's hard requirement that "what was done — issue handling, PR links, status changes — sits at the very top" is satisfied by this top of document; "what you still have to do" sits at the very bottom.

Per `local:using-ssot` **Hook 4**, the SSOT-TASK-TREE result section is mandatory in all three modes. It is the link between "what the user asked for" (SSOT-LIST) and "what was actually delivered" (artifacts). Without it, completion reports drift into narrative.

## Mode resolution

### Path B — invoked by the harness at turn-end

The harness (`src/slack/summary-service.ts`) computes the mode from session state via `selectExecutiveSummaryMode(session)` and injects it into the prompt as

```
Active ES mode: <brief|issue|epic> (host-selected; do not reclassify)
```

When you (the LLM) see this header, **trust it**. Do not second-guess. The host knows `links.pr`, `linkHistory.prs`, `linkHistory.issues`, `workflow`, and `handoffContext.parentEpicUrl` directly — the conversation transcript does not.

The Path B response is a leading `<tldr>` block (exactly 3 lines) followed by the ES document; the section order above (SSOT → Status → …) applies to the document after the block. The host shows only the TL;DR on the channel-visible thread surface and posts TL;DR + full document inside the thread. The contract itself lives in `SUMMARY_PROMPT` (`packages/slack/src/summary-service.ts`) — this note only describes it.

### Path A — invoked at z phase5, or manually via `$es` outside the z pipeline

Inside the z pipeline `es` runs at **phase5**, after `zcheck` has already passed at phase3 and `ztrace`+approve completed at phase4. The direct `zwork` exit → `es` shortcut applies only when `es` is invoked outside the z pipeline (standalone `$es` or a Path B harness call).

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
4. Collect concrete artifacts from the conversation (links + state + files + commands + commits + outcomes). For every issue, PR and document **this session created**, read its current state (Path A: `gh pr view <n> --json state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup` / `gh issue view <n> --json state,stateReason`; Path B: the conversation and the host's Session Context only).
5. Classify each own artifact as complete or unfinished ([Unfinished own artifacts](#unfinished-own-artifacts)). Any unfinished one → the ⚠️ TL;DR line and the final `⚠️ User follow-up required` section are mandatory.
6. Write the summary following the mode template. Respect the language of the conversation.
7. **Card sync (Path A only)** — `GET_SESSION` → `UPDATE_SESSION` (links with state, title, TL;DR) → `GET_SESSION` again to verify. See [Card sync](#card-sync). Path B has no tools; the host syncs the card from the TL;DR it parses.

## Global rules (apply at every mode)

- **No table-only listings** — every section is connected with narrative, even at `brief`.
- **Include all issue/PR/document links with current state** — `Open / Draft / Merged / Closed / QA / etc.`. Mark the ones **created this session** (`🆕 created this session`) apart from the ones only touched; documents (HTML artifacts, Confluence pages, uploaded reports, spec files) count.
- **Quote the user verbatim** in SSOT — never paraphrase, summarize, or "clean up".
- **Concrete artifacts, no abstractions** — `src/foo.ts:42`, command names, PR numbers, commit hashes. Never invent values you did not see.
- **Omit sections that have nothing to report** — do not fabricate, do not hedge.
- **Same language as the conversation** — Korean session ⇒ Korean ES.
- **No tool calls when run as one-shot fork** (Path B). When run manually as Path A you may use `git` / `gh` for discovery, and the session model command (`GET_SESSION` / `UPDATE_SESSION`) for [Card sync](#card-sync) — nothing else.

## Unfinished own artifacts

An **own artifact** is an issue, PR or document this session created (not one it only read or commented on). It is **complete** only in a terminal state:

| Kind | Complete | Unfinished (examples) |
|---|---|---|
| PR | **Merged**, or **Closed** on purpose with the reason stated (superseded by #N, dropped by decision) | Open, Draft, review requested, changes requested, approved-but-unmerged, CI failing/pending, merge conflict, blocked by branch protection |
| Issue | **Closed** (completed, or not planned with the reason stated) | Open, waiting on QA / deploy / another PR / a decision |
| Document | Published where the user reads it (uploaded, linked, merged) | Draft only on local disk, upload failed, link dead |

When **any** own artifact is unfinished, three things are mandatory — in Path A and Path B alike:

1. **TL;DR ⚠️ line.** One TL;DR line starts with `⚠️` and states, in bold, which artifact is not complete and why it cannot be completed by the agent — the concrete blocker, never "pending": `⚠️ **PR #830 not merged — merging needs a maintainer approval the bot does not have.**` Several unfinished artifacts share one ⚠️ line (`⚠️ **PR #830 unmerged (approval) · issue #829 open (needs prod deploy)**`). The TL;DR stays 3 lines: outcome · ⚠️ blocker · next step. A line that starts with `⚠️` is reserved for this signal only — never use it for a risk, a flaky test or a note.
2. **`⚠️ User follow-up required` as the very last section.** For each unfinished artifact: link + current state · why the agent could not complete it (the blocker and its evidence: the error, the missing permission, the failing check) · who must act (the user, a reviewer, an admin) · numbered steps with copy-ready commands or exact clicks · how to verify it is done · what to tell the agent afterwards so it continues (`reply "merged" in this thread → the agent runs the dev deploy`). Bold the blocker line of each item.
3. **The card waits for the user.** The ⚠️ TL;DR line is what moves the session's task card to **NEEDS YOU** (waiting for the user's follow-up input) instead of DONE, with the blocker as the card's summary line. Path A writes the TL;DR to the card ([Card sync](#card-sync)); Path B's TL;DR is parsed by the host. The card leaves NEEDS YOU when the next Executive Summary's TL;DR has no ⚠️ line (the work got finished), or on `/new`.

No unfinished own artifact → no ⚠️ line, no follow-up section. Never invent a blocker to look diligent, and never hide one to look done.

## Card sync

The session's task card (dashboard) shows the session title, the issue/PR/document links with their state, and the TL;DR. Running `es` keeps it true.

**Path A (model-run — z phase5, autoz terminal report, `$es`)**. After writing the document, in the same turn:

1. `GET_SESSION` — read what the card already lists (`issues`, `prs`, `docs`, `active`, `sequence`).
2. `UPDATE_SESSION` once, with:
   - `operations` — for every issue/PR/document this session created or changed state of: `{ action: "add", resourceType: "issue" | "pr" | "doc", link: { url, type, provider, label: "#830", title, status } }`. `status` is the state you just read (`open`, `draft`, `merged`, `closed`, …). Re-adding a known URL updates it in place. Then `{ action: "set_active", resourceType, url }` for the artifact the session is about now.
   - `title` — when the session still has a stand-in title or the work's subject changed (≤ 100 chars).
   - `executiveSummary: { tldr: [line1, line2, line3] }` — the same TL;DR lines the document opens with, ⚠️ line included. This is what puts the TL;DR on the card and what keeps the card in NEEDS YOU.
3. `GET_SESSION` again — verify: every own artifact is listed with the state you wrote. `prs: []` after you created a PR is an alarm: fix the write before you finish. Write full URLs in the document too (short refs like `#830` are not captured).
   - Limit: `GET_SESSION` answers from the model-command server's own copy, not the host's. A write the host could not apply shows up in the thread as `⚠️ Session update could not be applied on host (<reason>)` — when you see it, the card did not change: retry once without `expectedSequence`, then say in the document that the card is stale. The TL;DR and follow-up are not in `GET_SESSION` at all; the dashboard card is their only receipt.

**Path B (host-run, no tools)** — do not attempt any tool call. The host parses the `<tldr>` block: it puts the lines on the card and derives the NEEDS YOU follow-up from the ⚠️ line. Links reach the card from the session's own capture; the document must still carry full URLs.

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
- An own PR/issue left Open/Draft with no ⚠️ TL;DR line and no follow-up section — the card lands in DONE while work is unfinished.
- A ⚠️ line that says "pending" without the blocker, or a follow-up section without steps the user can run.
- Path A finishing without the card sync, or without re-reading the card after the write.

## Integration

- **Path A entry (inside z pipeline)**: z phase3 `local:zcheck` → phase4 `local:ztrace` + approve → phase5 `local:es`. `es` runs **after** `zcheck` has passed at phase3, not before. The `local:zwork` exit → `local:es` direct path only applies when `es` is invoked outside the z pipeline (standalone `$es`).
- **Path B entry**: `src/slack/pipeline/stream-executor.ts` `onSummaryTimerFire` → `SummaryService.execute` → forked one-shot using this skill's templates inlined in the prompt.
- **Sister skills**: `using-ssot` (SSOT-TASK-TREE source of truth — every mode renders the tree result), `using-ha-thinking` (layer discipline), `using-epic-tasks` (planning-side Case A/B/C), `decision-gate` (switching-cost tiers).
- **Legacy references** (kept, not deleted): `reference/executive-summary-template.md`, `reference/executive-summary-example.md`. These cover the previous fixed 8-section format and serve as the conceptual ancestor of the current `epic` template.
