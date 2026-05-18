---
name: release-notes
description: Generate bilingual (EN/KO) release notes from two git refs. Analyzes commits and diffs to produce user-centric, Keep a Changelog formatted notes.
argument-hint: <BASE_REF> <HEAD_REF>
allowed-tools: Bash, Read, Grep, Glob
---

# Release Notes Generator

Generate bilingual (English + Korean) release notes between two git references.

## Input

**Arguments:** `$ARGUMENTS`

Expected format: `<BASE_REF> <HEAD_REF>`

Examples:
- `v1.2 v1.3` (tags)
- `abc1234 def5678` (commit SHAs)
- `v1.2 HEAD` (tag to current)

## Workflow

### 1. Parse & Validate Arguments

Extract `BASE_REF` and `HEAD_REF` from `$ARGUMENTS`. If fewer than 2 arguments provided, ask the user.

Validate both refs exist:

```bash
git rev-parse --verify BASE_REF
git rev-parse --verify HEAD_REF
```

If either fails, report the invalid ref and stop.

### 2. Gather Raw Data (parallel)

Run all of these in parallel:

```bash
# Commit list (one-line summary)
git log --oneline BASE_REF..HEAD_REF

# File change statistics
git diff --stat BASE_REF..HEAD_REF

# Full diff for understanding changes
git diff BASE_REF..HEAD_REF

# Commit messages with full bodies
git log --format='%h %s%n%b---' BASE_REF..HEAD_REF

# Version tags for context
git tag -l --sort=-v:refname | head -20

# Dates for the range
git log -1 --format='%ci' HEAD_REF
```

Also determine the GitHub compare URL if this is a GitHub repo:

```bash
git remote get-url origin
```

Construct: `https://github.com/OWNER/REPO/compare/BASE_REF...HEAD_REF`

### 3. Analyze Changes

Read relevant source files referenced in the diff to understand the **user impact** of each change. Do not just parrot commit messages — understand what each change means for someone using the software.

Classify every change into one of these categories (skip empty categories in output):

| Category | What belongs here |
|----------|-------------------|
| **Breaking Changes** | API signature changes, removed features, config format changes, renamed commands — anything that requires user action to upgrade |
| **Added** | New user-facing features, new commands, new configuration options |
| **Changed** | Modified existing behavior, performance improvements, UX refinements |
| **Fixed** | Bug corrections, crash fixes, data integrity fixes |
| **Security** | Vulnerability patches, auth improvements, input sanitization |
| **Deprecated** | Features marked for future removal |

**Framing rules:**
- Write from the **user's perspective**: "You can now..." / "Sessions now..." — not "Implemented X" or "Refactored Y"
- Lead with the **benefit**, not the mechanism
- Internal refactors with no user-visible effect go under Changed only if they affect performance/reliability; otherwise omit them
- Group related commits into a single bullet when they serve one logical change

### 4. Generate English Release Notes

Use this exact structure (omit empty sections):

```markdown
# [VERSION or HEAD_REF] — YYYY-MM-DD

> One-sentence theme summarizing what this release is about.

## Highlights

- 3–5 most important changes in plain language
- Each highlight should be understandable without reading the full notes

## Breaking Changes

- **What broke** — What to do about it.
  - Before: `old way`
  - After: `new way`

## Added

- **Feature name** — What users can now do.

## Changed

- **Area** — What's different and why it matters.

## Fixed

- **Bug summary** — What was broken, now works correctly.

## Deprecated

- **Feature** — Will be removed in vX.Y. Use Z instead.

## Security

- **Issue** — What was vulnerable, now patched.

---

**Stats:** N commits, M files changed, +X / −Y lines
**Full diff:** [BASE_REF...HEAD_REF](compare_url)
```

### 5. Generate Korean Release Notes

Translate the English notes into Korean following these rules:

- Use `합니다`체 (formal polite) consistently
- Preserve IT loanwords as-is: 세션, API, 스피너, 리액션, MCP, 스레드, 워크플로우, etc.
- Do NOT translate proper nouns, command names, or code identifiers
- Omit unnecessary pronouns — Korean context handles subject naturally
- Restructure for natural SOV grammar; do not translate word-by-word
- Section headers stay bilingual: `## 주요 변경사항 (Breaking Changes)`

Use this structure for Korean headers:

| English | Korean |
|---------|--------|
| Highlights | 하이라이트 |
| Breaking Changes | 주요 변경사항 (Breaking Changes) |
| Added | 추가 |
| Changed | 변경 |
| Fixed | 수정 |
| Deprecated | 지원 중단 예정 |
| Security | 보안 |

### 6. Output

Present both versions in a single response:

```
# Release Notes (English)

[English release notes from Step 4]

---

# 릴리즈 노트 (한국어)

[Korean release notes from Step 5]
```

## Error Handling

- **Missing arguments**: Ask user for BASE_REF and HEAD_REF
- **Invalid ref**: Report which ref failed `git rev-parse` and suggest checking with `git tag -l` or `git log --oneline -10`
- **Empty range**: If `git log BASE..HEAD` returns nothing, report "No commits between these refs"
- **Not a git repo**: Report that the current directory is not a git repository
