# Workflow Network

This document describes the overall structure of the soma-work workflow network.

## Overall Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Input                                │
│  z + task/issue/PR  │  Jira board  │  Jira issue  │  PR link  │ Deploy │
└────────┬───────────┬────────────┬────────────┬──────────┬──────┘
         │           │            │            │          │
         ▼           ▼            ▼            ▼          ▼
    ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐
    │  zwork  │ │executive │ │brainstorm│ │pr-review│ │ deploy │
    │(auto-   │ │ summary  │ │ -ing     │ │         │ │        │
    │execute) │ └──────────┘ └────┬─────┘ └────┬────┘ └────────┘
    └────┬────┘                   │            │
         │                   ┌────▼─────┐      │
         │                   │ planning │      │
         │                   └────┬─────┘      │
         │                   ┌────▼─────┐      │
         │                   │create-pr │·····┤ (manual guidance)
         │                   └──────────┘      │
         │                                ┌────▼──────────────┐
         └───────────────────────────────►│pr-fix-and-update  │
                                          └───┬───────────────┘
                                              │ CONTINUE_SESSION
                                              ▼
                                         ┌─────────┐
                                         │pr-review│ (recursive)
                                         └─────────┘
```

## Workflow List

| Workflow | Trigger | Role |
|----------|---------|------|
| `zwork` | `z` + task/issue/PR | Autonomous execution orchestrator. Chains stv:* skills for issue -> implementation -> PR -> merge |
| `jira-executive-summary` | Jira board link | Sprint status summary. Analyzes In Progress/Todo/Done |
| `jira-brainstorming` | Jira issue link | Issue analysis + implementation option derivation. Includes codebase exploration |
| `jira-planning` | Jira issue + "plan" | Implementation Spec creation and user approval |
| `jira-create-pr` | Jira issue + "fix"/"work" | PR creation via Red -> Green -> Refactor |
| `pr-review` | GitHub PR link | PR review. Switching cost classification + autonomous/user decision separation |
| `pr-fix-and-update` | PR + "fix" | Apply review feedback. Autonomous fix + user confirmation |
| `deploy` | `repo source -> target` | Branch deployment. clone -> PR -> merge -> release notes |
| `onboarding` | New user's first message | Initial setup and usage guide |
| `pr-docs-confluence` | PR + Confluence link | Write Confluence documentation based on PR changes |

## Three Key Flows

### 1. Jira -> Implementation Flow

```
jira-executive-summary → jira-brainstorming → jira-planning → jira-create-pr → pr-review
```

- Identify issues in executive-summary
- Decide implementation direction in brainstorming
- Finalize Implementation Spec in planning
- Red -> Green -> Refactor in create-pr
- Review + merge in pr-review

### 2. PR Review Loop

```
pr-review ⇄ pr-fix-and-update (bidirectional recursion via CONTINUE_SESSION)
```

- Issues found in pr-review -> switch to pr-fix-and-update
- After fix is complete, automatically re-enter pr-review
- Repeat until all issues are resolved
- Merge when merge gate is passed

### 3. zwork Autonomous Execution

```
zwork → stv:new-task → stv:do-work → stv:verify → github-pr → pr-fix-update → pr-review
```

- zwork analyzes the input and executes the appropriate stv skill chain
- Proceeds autonomously from issue creation to PR merge
- Retries on verification failure at each step

## Transition Mechanisms

Transitions between workflows happen in three ways.

### CONTINUE_SESSION (Strongest Connection)

Switches the workflow within the same thread. Resets the session and forces a new workflow.

```json
{
  "commandId": "CONTINUE_SESSION",
  "params": {
    "prompt": "new <URL>",
    "resetSession": true,
    "dispatchText": "<URL>",
    "forceWorkflow": "<workflow-name>"
  }
}
```

Used in:
- `pr-review` -> `pr-fix-and-update` (when fix is needed)
- `pr-fix-and-update` -> `pr-review` (re-review after fix)
- `pr-review` -> `pr-review` (when rerun_review is selected)

### UIAskUserQuestion (User Choice-Based Transition)

Transitions by letting the user select the next step. Uses the `local:UIAskUserQuestion` skill.

Used in:
- `jira-brainstorming` -> `jira-planning` or `jira-create-pr`
- `pr-review` merge gate -> merge/rerun/wait selection

### Manual Guidance (Weakest Connection)

Text guidance like "Enter ~ in a new session." Since it breaks the flow, it should be minimized.

Used in:
- `jira-executive-summary` -> `jira-brainstorming` (specific issue analysis)
- `jira-planning` -> `jira-create-pr` (PR creation)
- `jira-create-pr` -> `pr-review` (PR review request)

## Common Infrastructure (common.prompt)

Foundation shared by all workflows via `{{include:./common.prompt}}`:

- **Working folder rules**: Unique folder creation + git clone
- **Disk space check**: fast_fail if under 512MB
- **Model-command-tool priority**: UIAskUserQuestion, session links, etc. prioritize MCP
- **Sub-models (MCP)**: codex (highest performance), gemini (good performance)
- **Auto session title update**: On issue link, on PR merge

## Key Skill Dependencies

```
Workflow -> Skill Mapping:

zwork:
  - stv:new-task, stv:debug, stv:do-work, stv:verify
  - local:github-pr, local:decision-gate

pr-review:
  - local:github-pr (PR data collection)
  - local:review-pr (executor)
  - local:oracle-reviewer, local:oracle-gemini-reviewer (3-reviewer vote)
  - local:UIAskUserQuestion (user questions)
  - local:decision-gate (autonomous/user classification)
  - mcp__jira__getJiraIssue / mcp__github__get_issue (issue retrieval)

pr-fix-and-update:
  - local:github-pr (PR data collection)
  - local:oracle-reviewer, local:oracle-gemini-reviewer (fix direction vote)
  - code-simplifier (code cleanup)

jira-*:
  - mcp__jira__* (Jira API)
  - local:UIAskUserQuestion

deploy:
  - local:UIAskUserQuestion (deployment confirmation)
  - local:release-notes (release notes generation)
```

## Issue Tracking Flow

The PR review workflow requires issue linking:

1. Auto-extract issue key from PR body/branch/title
2. If extraction fails, request the issue link from the user
3. Include the issue's Acceptance Criteria in the review criteria
4. Auto-register the issue link in the session
