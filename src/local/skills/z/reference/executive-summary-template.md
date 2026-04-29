# 🎯 {ISSUE_KEY} Executive Summary

> **This is a placeholder template only.** All slots use `{…}` form. For a worked example with concrete content, see `executive-summary-example.md`.

## 0. SSOT
- SSOT
```
{Original user instruction — verbatim, no summary. Multiple lines OK.}
```
- {ISSUE_KEY}: {issue tracker URL} - {status}
- PR #{number}: {PR URL} - {Merged | Open | Draft}
- PR #{number}: {PR URL} - {Merged | Open | Draft}

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
