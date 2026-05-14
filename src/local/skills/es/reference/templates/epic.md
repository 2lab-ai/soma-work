# Executive Summary — `epic` mode

For sessions spanning **multiple PRs / sub-issues / a root-cause analysis / an STV verify cycle**. This is the Case-B / multi-PR equivalent. Stakeholders read this to make a deployment / QA / next-cycle decision.

## HA discipline (binding)

> A sentence written in this layer must close without using terms from the layer below.

Concretely: at `epic` mode, **real artifacts are issue links, PR links, statuses, and architectural outcomes** — not files, functions, or commit hashes. Leaf-level implementation detail belongs in the linked sub-issue or PR body, not in this document. An epic ES that lists `src/foo.ts:42` is a long `issue` ES wearing the wrong template.

## Top-of-document invariant

1. **SSOT** — user's request verbatim, first.
2. **Status** — epic + all child issues + all child PRs with their current state, immediately after SSOT. State changes that happened this session must be explicit.

## Sections (in order)

### 0. SSOT
- Quote the user's instruction verbatim inside a fenced block. Multiple turns → preserve order + speaker labels.

### 1. Status
- Epic: `{label}: {url} — {state}` plus Done / Remaining counts (`5/7 sub-issues merged`).
- Child issues: table with `# | Title | URL | State`.
- Child PRs: table with `# | Title | URL | State | Reviewer / Approval`.
- Session-scoped state transitions: list them ("PR #1462 Open → Merged").

### 2. Executive Summary
- One short paragraph: the architectural outcome of this epic — what changed at the system level, what is now possible / fixed / measurable. Concept language only.

### 3. Workstream Status
- Per workstream (or per sub-issue), 1–2 lines on where it stands. Block-level granularity, not function-level.

### 4. Verification
- STV verify or end-to-end check outcomes per spec item.
- Table: `Spec Item | Status (✅/❌/🔶) | Verification Method`.
- Final Verdict: `PASS / PARTIAL / GAP_DETECTED / FAIL` with `{N}/{N} satisfied, {N} gaps`.

### 5. Decisions Made
- Architectural / scope decisions settled this cycle, with rationale. Explicit decision signals only — no inferred decisions.

### 6. Risks / Blockers
- Table: `Item | Status (⚠️/🔶/✅) | Action`.
- Include: unverified failure points, deployment status, monitoring recommendations, residual damage that needs reconciliation.

### 7. Next Actions
- Up to 5 concrete follow-ups. Each in its own fenced code block.

## Forbidden in epic mode

- **No file paths** in section bodies. Link to the sub-issue / PR; that's where files live.
- **No function names / commit hashes** in section bodies.
- **No long code blocks**. One-line shell snippets in "Next Actions" are fine; multi-line diffs are not.
- **No Decisions Made entries inferred from descriptive text**. Only items where the conversation explicitly chose between alternatives.

## Anti-patterns

- Empty Status table while child PRs / issues exist.
- Restating SSOT in your own words.
- Listing every file edited in every sub-PR (= long `issue` ES wearing epic clothes).
- Inferring decisions from implementation language.
- Padding sections that have nothing concrete to report — omit instead.
