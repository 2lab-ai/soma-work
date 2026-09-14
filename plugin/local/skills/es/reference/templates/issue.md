# Executive Summary — `issue` mode

For sessions producing **one durable unit of work**: one issue, one PR, one branch. Implementation detail is welcome here — this is the Case-A equivalent of `using-epic-tasks`. Sub-issues of an epic are also `issue` mode (one leaf at a time).

## Top-of-document invariant

1. **SSOT** — user's request verbatim, first.
2. **Status** — issue + PR links with current state, immediately after SSOT. This is the "what was done" signal the user mandated stays at the top of every tier.

## Sections (in order)

### 0. SSOT
- Quote the user's instruction verbatim inside a fenced block. Multiple messages → preserve order + speaker labels.
- This is **SSOT-LIST** per `local:using-ssot` — append-only.

### 1. Status
- One bullet per linked issue/PR: `{label}: {url} — {state}` (Open / Draft / Merged / Closed / QA / etc.).
- Include parent epic link if known.
- Include state changes that happened **this session** (e.g. `Open → Merged`).

### 2. SSOT-TASK-TREE result (`local:using-ssot` Hook 4)
- Render the session's final SSOT-TASK-TREE at the `ssot-task` layer.
- For **each** `ssot-task`, three lines:
  - **Requirement** — quote the SSOT excerpt this task came from.
  - **Did** — concrete artifact(s) that satisfy it: `src/foo/bar.ts:42`, commit hash, `npm test` result, PR comment URL.
  - **Why it satisfies** — one-line causal mapping. Not narrative.
- Render `ssot-task` layer only — `ssot-subtask` is volatile (`using-ssot` Invariant 4) and not part of completion reports.

### 3. Summary
- One paragraph: what changed, what user-visible behavior is now different. Use real artifact references — `src/foo/bar.ts:42`, `gh pr merge 1234`, commit hashes. Avoid abstractions like "refactored auth".

### 4. Verification
- Tests/builds/lint runs that were executed this session and their outcomes.
- Format: bullet list of `{command} → {result}`. Skip if nothing was verified this session.

### 5. Decisions Made
- Specific design/scope choices that were settled, with the rationale.
- Only include items with explicit decision signals ("we chose…", "approved", "alternative X considered and rejected because…"). Descriptive implementation language is NOT a decision. Skip if none.

### 6. Next Actions
- Up to 3 concrete next steps. Each in its own fenced code block.

## Concrete artifact rules

- "Be specific" — `Edited src/auth/login.ts:88 to add JWT refresh, ran npm test (12 passed)` over `Refactored auth`.
- Reference: file paths, function names, PR numbers, error messages, command names actually present in the conversation.
- Never invent values you did not see in history.

## Anti-patterns

- Restating SSOT in your own words.
- Empty Status section while a PR/issue exists.
- Pure abstractions ("improved error handling") with no file/path/command evidence.
- Inflating to Workstream Status / Risks / multi-PR fix-history table — that's `epic` mode.
