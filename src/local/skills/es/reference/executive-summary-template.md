# 🎯 {ISSUE_KEY} Executive Summary

> **Synthetic example.** The filled-in section 0 below is invented, like every value in
> `reference/executive-summary-example.md`. This file ships inside a public package: keep the
> placeholders and the synthetic sample, never paste a real report from a private or customer
> codebase into it.

## 0. SSOT
- SSOT
```
@reporter [2026/03/30 11:52 AM] @assistant Research job
Intent:
- Split the jobs that can run in parallel (feed polling, digest scan) out of the main worker.
  A read-only database context would be ideal for most of them
- Thoughts
  - Separate the background job executors
  - Run the scheduled jobs periodically and finalize by calling the notifier service API
  - Only the read-only replica should be reachable from there
@reporter [2026/03/30 12:49 PM] Approved — wrap it up
```
- EXAMPLE-42: https://example.atlassian.net/browse/EXAMPLE-42 - QA
- PR #12: https://github.com/example-org/example-service/pull/12 - Merged
- PR #15: https://github.com/example-org/example-service/pull/15 - Merged

## 1. Problem Background

A failure was {discovered/suspected} in **{system/pipeline}** where **{what is failing and how}**.

**Impact Chain**:
```
{Starting service/method}
  → {Intermediate processing}
    → {Failure point} (blocked here!)
      → {Downstream impact 1}
        → {Downstream impact 2}
```

**Business Impact**:
- **{Impact 1}**: {Specific description}
- **{Impact 2}**: {Specific description}
- **{Impact 3}**: {Specific description}

## 2. Root Cause Analysis

### Issue Failure Points ({N} total)

| # | Failure Point | Location | Diagnosis |
|---|---------------|----------|-----------|
| 1 | {Point description} | {file:line} | {Needs verification / 🔴 Code defect confirmed} |
| ... | ... | ... | ... |

### Code Defects Found: {N}

**Defect A — {Defect name} (Root Cause)**

{1-2 sentence explanation of what went wrong and why}

```
❌ AS-IS: {Current code/behavior}
✅ TO-BE: {Fixed code/behavior}
```

{Detailed explanation of the defect mechanism}

**Defect B — {Defect name}**

{Description}

## 3. Fix History

### PR #{number} — {title} ({MERGED/OPEN} {date})

| Item | Details |
|------|---------|
| **Change** | {What was changed and how} |
| **Files** | {filename} (+{N} -{N}) |
| **Effect** | {What this change restores/improves} |
| **Review** | {Reviewer / approval status} |

### PR #{number} — {title} ({MERGED/OPEN} {date})

| Item | Details |
|------|---------|
| **Change** | {What was changed and how} |
| **Files** | {filename} (+{N} -{N}) |
| **Quality** | {Review score / loop count} |
| **Review** | {Reviewer / approval status} |

## 4. STV Verify Results

| Spec Item | Status | Verification Method |
|-----------|--------|---------------------|
| {Spec item 1} | ✅/❌ | {How it was verified} |
| {Spec item 2} | ✅/❌ | {How it was verified} |
| ... | ... | ... |

**Verdict: {PASS / PARTIAL / GAP_DETECTED / FAIL}** — {N}/{N} spec items satisfied, {N} gaps

## 5. Timeline

| Time (UTC) | Event |
|------------|-------|
| {MM/DD HH:MM} | {Issue discovered/created} |
| {MM/DD HH:MM} | {Analysis complete / key finding} |
| {MM/DD HH:MM} | {PR created} |
| {MM/DD HH:MM} | {Review/approval} |
| {MM/DD HH:MM} | **{PR MERGED}** |
| {MM/DD HH:MM} | {Deployment} |

## 6. Risks and Follow-up Actions

| Item | Status | Action |
|------|--------|--------|
| **{Existing damage}** | ⚠️ Unverified | {Verification/recovery method} |
| **{Deployment status}** | ✅/🔶 | {Which environments it has been deployed to, next deployment schedule} |
| **{Monitoring}** | 🔶 Recommended | {Which logs/metrics to watch, normal/abnormal criteria} |
| **{Unverified failure points}** | 🔶 Unverified | {Items requiring runtime verification, configuration-based issues} |
| **{Jira issue status}** | {Status} | {Follow-up QA/verification needs} |

## 7. AS-IS → TO-BE Summary

| Category | AS-IS | TO-BE |
|----------|-------|-------|
| **{Item 1}** | {Previous state} | ✅ {State after fix} |
| **{Item 2}** | {Previous state} | ✅ {State after fix} |
| **{Item 3}** | {Previous state} | ✅ {State after fix} |
| ... | ... | ... |
