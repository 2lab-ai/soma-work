---
name: github-pr
description: Fetch PR data from GitHub with token-efficient output. Use when reviewing PRs, checking PR status, or preparing PR summaries.
argument-hint: <PR_URL or owner/repo#number>
allowed-tools: Bash, Read, mcp__github__get_pull_request, mcp__github__get_pull_request_reviews, mcp__github__get_pull_request_comments, mcp__github__get_pull_request_files
---

# GitHub PR Data Extractor

Fetches PR information from GitHub and returns a compact, token-efficient representation.

## Input

**PR Identifier:** `$ARGUMENTS`

Supported formats:
- `https://github.com/owner/repo/pull/123`
- `owner/repo/123` or `owner/repo#123`

## Workflow

### 1. Parse PR Identifier

Extract `owner`, `repo`, and `pr_number` from the input. If ambiguous, ask user for clarification.

### 2. Fetch PR Data (parallel)

Call these MCP tools in parallel:
- `mcp__github__get_pull_request` - PR metadata
- `mcp__github__get_pull_request_reviews` - Review status
- `mcp__github__get_pull_request_comments` - Line comments
- `mcp__github__get_pull_request_files` - Changed files

**NEVER READ IT DIRECTLY** only read it after **extract essentail data** from following steps.

### 3. Extract Essential Data

Use the bundled extraction script for large responses:

```bash
npx tsx local/skills/github-pr/scripts/extract-pr-data.ts pr /path/to/pr.json
npx tsx local/skills/github-pr/scripts/extract-pr-data.ts comments /path/to/comments.json
npx tsx local/skills/github-pr/scripts/extract-pr-data.ts reviews /path/to/reviews.json
npx tsx local/skills/github-pr/scripts/extract-pr-data.ts files /path/to/files.json
```

For inline processing, keep only essential fields:

| Data Type | Keep | Remove |
|-----------|------|--------|
| PR | number, title, state, user.login, body, dates, stats, labels | Most URLs, full user objects |
| Comments | id, node_id, path, line, body, user.login, html_url, in_reply_to_id | diff_hunk, _links, avatar_url |
| Reviews | id, user.login, state, body, submitted_at | All URLs except html_url |
| Files | filename, status, additions, deletions | patch, blob_url |

**Important IDs to keep:**
- `id` - REST API reply
- `node_id` - GraphQL thread resolve
- `html_url` - User permalinks

### 4. Format Output

```markdown
# PR #{number}: {title}

| Field | Value |
|-------|-------|
| **State** | {state} |
| **Author** | @{user} |
| **Branch** | `{head}` -> `{base}` |
| **Stats** | +{add} -{del} ({files} files) |

## Description
{body}

## Files Changed ({count})
| File | Status | +/- |
|------|--------|-----|
| `{filename}` | {status} | +{add}/-{del} |

## Reviews ({count})
| Reviewer | State | Comment |
|----------|-------|---------|
| @{user} | {state} | {body preview} |

## Comments ({count})
### `{path}:{line}` - @{user} [link]({html_url})
{body}
```

## Error Handling

- **Invalid format**: Ask user for correct PR URL
- **PR not found**: Report 404 with owner/repo/number
- **Rate limited**: Report GitHub API rate limit
- **Invalid JSON**: Report parsing error with content preview
- **Missing fields**: Report which field is missing

## Workflow Actions Reference

### Reply to Comment
```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment.id}/replies -X POST -f body="Reply"
```

### Resolve Thread
```bash
# Query thread ID first (comment.node_id != thread ID)
gh api graphql -f query='query($id: ID!) { node(id: $id) { ... on PullRequest { reviewThreads(first: 100) { nodes { id comments(first: 1) { nodes { id } } } } } } }' -f id="$PR_NODE_ID"

# Then resolve
gh api graphql -f query='mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }' -f id="$THREAD_ID"
```
