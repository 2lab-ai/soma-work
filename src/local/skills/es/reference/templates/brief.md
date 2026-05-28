# Executive Summary — `brief` mode

For sessions with **no durable artifact** this turn: no PR opened or updated, no issue created, just Q&A, exploration, single-file edits without commit/PR, or a clarification round.

## Top-of-document invariant

1. **SSOT** — quote the user's request verbatim. Never paraphrase. This is the user's authority over scope.
2. **Status** — **OMIT THIS SECTION ENTIRELY** when there is no PR/issue link or state change. An empty Status section trains readers to skip the top of the document. Only render it when at least one link or state change actually exists from earlier in the session.

## Sections (in order)

### 0. SSOT
- Paste the user's request verbatim inside a fenced block (no edits).
- If the request spans multiple messages, paste each in order, marked with the speaker label and timestamp if known.
- This is **SSOT-LIST** per `local:using-ssot` — append-only, raw text.

### (optional) Status
- Only if a link or state change exists from earlier in the conversation.
- Format: bullet list of `{label}: {url} — {state}`.

### 1. SSOT-TASK-TREE result
- Always rendered. Never omitted.
- If a tree exists: render the session's final SSOT-TASK-TREE (ssot-task level only — ssot-subtask is volatile and omitted at `brief`). For each `ssot-task`: status (`[x]` / `[ ]` / `n/a`) + one-line outcome.
- If no tree was built (pure Q&A with no actionable decomposition): the section is exactly one line — `no decomposable tasks — Q&A only`.

### 2. Outcome
- One paragraph or 2–4 bullets describing what was answered, decided, or attempted this turn.
- Use the same language as the conversation.

### 3. Key Details
- Up to 5 bullets. Real artifacts only: file paths read, commands run, decisions reached. Never invent.

### 4. Next Actions
- Up to 3 concrete next steps. Each in its own fenced code block for easy copy.

## Anti-patterns

- Rendering an empty Status section "for consistency".
- Inflating into Decisions / Verification / Risks sections — those belong to `issue` mode.
- Fabricating commits or PRs that were not actually created.
- Restating the user's request in your own words inside SSOT.
