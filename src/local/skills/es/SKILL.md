---
name: es
description: "Trigger: when local:zwork completed."
---

# Executive Summary

After work completion, produce a 7-section summary document that allows stakeholders to **make decisions based on this single document**. (Write with readable formatting using Slack markdownfmt + Slack Block Kit)

## Writing Procedure

1. Read `./reference/executive-summary-template.md` and understand the structure.
2. Read `./reference/executive-summary-example.md` and understand the tone and depth.
3. Collect the current session's work history (issues, PRs, commits, reviews).
4. Write the Executive Summary following the template structure.

## 7-Section Required Structure

| # | Section | Key Focus |
|---|---------|-----------|
| 0 | SSOT | User's original instruction verbatim + issue/PR links with current status |
| 1 | Problem Background | Impact Chain + business impact |
| 2 | Root Cause Analysis | Failure point table + code defect AS-IS/TO-BE |
| 3 | Fix History | Per-PR table of changes/files/effects/reviews |
| 4 | STV Verify Results | Per-spec item verification + Verdict |
| 5 | Timeline | Events by UTC time |
| 6 | Risks and Follow-up Actions | Status icons (✅/⚠️/🔶) + actions |
| 7 | AS-IS → TO-BE Summary | Before/after comparison by item |

## Writing Rules

- **No table-only listings** — each section must be connected with narrative.
- **Include all issue/PR links** — specify the current status of each (Open/Merged/QA, etc.).
- **Minimize user friction** — the reader should be able to determine their next action immediately after reading this document.
- **Never summarize** the user's original text in the SSOT section — quote it verbatim.
