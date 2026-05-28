---
name: zreflect
description: "Self-reflection when re-instruction detected. Treats re-instruction as drift, applies `local:using-ssot` Hook 2 (SSOT-LIST append + SSOT-TASK-TREE regen + diff), then produces a gap-analysis reflection report before resuming work."
---

# zreflect — Self-Reflection + Drift handler

**Only invoked when the instruction is NOT the first one in the session.**

A follow-up or repeated instruction means **drift**: the user added, corrected, or re-scoped requirements. zreflect now does two things in order — (1) update the SSOT model so the rest of the session works on the right tree, then (2) the structured gap analysis on the prior attempt.

## Process

### Step 0 — Drift intake

Apply `local:using-ssot` **Hook 2** on the new user message — append to SSOT-LIST, regenerate the tree, diff at `ssot-task` granularity, output the diff + refreshed tree, patch TodoWrite. See that skill for the canonical procedure. The `SSOT_n` reference below means the new raw message you just appended.

### Step 1 — Self-reflection report

After the SSOT model is correct, do the gap analysis:

1. **Read back the user's instruction exactly as given.** Quote the literal words of `SSOT_n` (the drift instruction that triggered this reflection).
2. **Output an executive summary** of the work done so far in this session, mapped to `ssot-task` IDs from the previous tree.
3. **Re-read the entire thread conversation** to determine:
   - Why the user had to give the instruction again
   - What was different between the user's instruction and your actions
   - What was failed to follow — name the specific `ssot-task` ID(s) that were misinterpreted or skipped
4. **Write a self-reflection report** as an `.md` file and send it to the user. The report must include:
   - SSOT-LIST (full, verbatim)
   - SSOT-TASK-TREE diff (added / changed / removed / kept) — copy from Step 0
   - The exact instruction that triggered the reflection (quoted from `SSOT_n`)
   - What was done vs. what should have been done, **tagged by `ssot-task` ID**
   - Root cause of the gap (misunderstanding? skipped step? wrong assumption?)
   - Corrective action for the remainder of this session
5. **Submit this self-reflection to `llm_chat(codex)` for evaluation**, relay the feedback to the user, reflect on it, and then resume normal work from the refreshed tree's incomplete leaves.

## When NOT to invoke

- First instruction in the session — skip entirely, proceed to phase0 (which runs `using-ssot` Hook 1 directly).
- User explicitly says "continue" or "proceed" without correction — no reflection needed, but **still run Step 0** if the message contained any new requirement at all. "continue" alone with no new requirement → skip Step 0 too.

## Anti-patterns

- Running the reflection report without first appending to SSOT-LIST (Step 0). The report ends up analyzing the old tree while the user is talking about the new one.
- (Other drift anti-patterns are owned by `local:using-ssot` §Anti-patterns + Invariant 5 — wipe+restart, treating drift as full retraction, etc. Not duplicated here.)
