---
name: UIAskUserQuestion
description: Send structured user-choice questions via model-command tool (Slack UI renders as buttons)
---

# UIAskUserQuestion — Structured User Choice

When your turn ends and you need the user to make a real decision, call the `ASK_USER_QUESTION` model-command with a `user_choice` or `user_choice_group` payload. Slack renders it as buttons + a `✏️ Other` button that is **added automatically by the renderer** — never put an "Other" option in your `choices`.

## Pre-requisite: decision-gate

First, determine the switching cost tier using the `decision-gate` Skill.

- **tier < small** → Autonomous judgment (3-person review majority vote). Do not use this skill.
- **tier >= medium** → Use this skill to ask about the implementation approach.

Asking the user about things that can be decided autonomously is a waste of time.

## Primary action

Call `mcp__model-command__run`:

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice",
      "question": "[medium ~50 lines] <question>",
      "context": "<current state · problem · impact · fix code · review consensus>",
      "recommendedChoiceId": "1",
      "choices": [
        { "id": "1", "label": "Option A: <action>", "description": "<trade-offs>" },
        { "id": "2", "label": "Option B: <action>", "description": "<trade-offs>" }
      ]
    }
  }
}
```

If multiple decisions are bundled, use `type: "user_choice_group"` + `choices: [{question, recommendedChoiceId, options:[...]}]` array.

## Recommended option

Mark the recommended option with the top-level `recommendedChoiceId` field (single choice) or per-question `recommendedChoiceId` (group). It must match one of the option `id`s. If it doesn't match, it is silently dropped (no error).

- **Slack single-choice** renders the recommended option as a solo emphasized row (`style: 'primary'`) with a `⭐ Recommended — <label>` banner above and a divider between the recommended row and the other options.
- **Slack multi-form** styles it inline (reordered to the front of the buttons row with `style='primary'` + `⭐` prefix) so the 50-block per-message budget is preserved.
- **Legacy fallback**: if `recommendedChoiceId` is missing, the renderer scans option labels for a trailing `(Recommended · N/M)` (or plain `(Recommended)`) marker and treats that option as recommended. The marker is auto-stripped from the displayed label. **Prefer explicit `recommendedChoiceId` over the label suffix.**

> Fallback (tool unavailable): Output the same structured JSON directly in the message. **In PR review context, plain text is strictly prohibited** — always use structured JSON or tool call.

## Question writing rules

1. **`[tier ~N lines]` prefix** — All questions must indicate the decision weight. Tier is calculated from `decision-gate` (tiny ~5 / small ~20 / medium ~50 / large ~100 / xlarge ~500).
2. **One question = one decision** — Tightly scoped. Separate multiple decisions using `user_choice_group`.
3. **Self-contained `context`** — The user must be able to decide without scrolling up. Must include:
   - Current state (code snippets)
   - Problem/impact (performance? stability? data loss?)
   - Specific actions for each option (files, changes, workload)
   - Trade-offs for each option
   - 3-person review consensus (Codex + oracle-reviewer + oracle-gemini-reviewer)
4. **2-4 options** — Slack UI renders `1️⃣-4️⃣` buttons up to 4. The 5th and beyond get cut off. `multiSelect` not supported (single-select only).
5. **Recommended option** — Set `recommendedChoiceId` to the id of the recommended option. (Legacy `(Recommended · N/M)` label suffix is still accepted as a fallback and is auto-stripped from display; prefer the explicit field.) N/M is the review vote count and should go into the `description` or `context` instead of the label.
6. **Actionable label** — Specific action that can be executed immediately upon selection. Meta options like "I'll think about it" are prohibited.
7. **Do not reference plan text in Claude Code native Plan mode (`ExitPlanMode`)** — The user cannot see the plan in the Plan mode UI, so plan approval there is `ExitPlanMode`'s responsibility, not this tool's.
   - *Outside Plan mode* — In custom controller skills like `local:z` (phase1 plan confirmation, phase2.9 PR approval), `local:zcheck` (Step 4 PR approve), `local:ztrace` (Phase 0 scenario confirmation), `local:zexplore`, and `local:decision-gate` (tier=medium branch), structured plan/PR/scope confirmation via this tool is the **correct** pattern. Use the pre-built templates below.
8. **Specify fallback default** — Adding a default action like "If no response, proceeding with Option A" at the end of `context` prevents blocking progress (optional).

## When to use / not use

### USE this skill when:
- The decision has switching cost **>= medium** as determined by `decision-gate`
- Architecture, data model, major dependency replacement
- In PR review, **selecting a specific implementation approach** for medium+ issues ("which approach to use for the fix")

### DO NOT use when:
- Switching cost < small → Resolve with `decision-gate` autonomous judgment
- Insufficient context → Read more code first and formulate implementation alternatives (in PR review context, **plain text is strictly prohibited**)
- Open-ended questions ("How can I help you?")
- Probing user intent with speculative options
- Requesting secrets/credentials to be shared in chat
- **Fix/Defer/Skip 3-choice questions like "Should we fix this? / Later / Don't fix"** — This is just a confirmation request, not a real decision. Fixing P1+ issues is self-evident. What you should ask is "**how** to fix it".

---

## Bad Examples

### BAD: Fix/Defer/Skip 3-choice (strictly prohibited)

```
→ Should we fix this issue in this PR? (fix_now / defer_to_followup / not_a_bug)
```

This is a simple confirmation, not a real decision. No implementation approach is offered. The correct question presents Option A vs Option B.

### BAD: Context-free question

```
question: "Found 2 P1 issues in PR #944. How should we handle them?"
choices:  [Proceed with fix, Delegate to PR author, Include P2 as well]
```

No tier, no code snippets, no problem description, no review consensus → User is forced to scroll up → Defeats the entire purpose of this UI.

---

## Good Example

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice",
      "question": "[medium ~50 lines] P1-1: Missing DbUpdateException filter — choose implementation approach",
      "context": "▸ Current (`src/Repo/UserRepo.cs:45`):\n```csharp\ncatch (DbUpdateException ex) { return Result.Conflict(); }\n```\n▸ Problem: All DB exceptions including network/timeout are treated as Conflict → risk of data loss.\n▸ Review consensus (3/3 Option A): Codex · oracle-reviewer · oracle-gemini unanimous.\n▸ Default if no response: Proceeding with Option A.",
      "recommendedChoiceId": "option_a",
      "choices": [
        {
          "id": "option_a",
          "label": "Option A: Add when filter",
          "description": "`catch (DbUpdateException ex) when (IsDuplicateKeyException(ex))` — Bulk update 4 files, add 4 tests. Minimal change, intuitive. (Review consensus 3/3.)"
        },
        {
          "id": "option_b",
          "label": "Option B: Switch to Result<T> pattern",
          "description": "Repository stops throwing exceptions and returns Result<T> instead — 6 files, ~80 lines. Cleaner but wider scope."
        }
      ]
    }
  }
}
```

## Caller templates

Each caller skill has a pre-built JSON template under [`templates/`](./templates/) that satisfies all six quality rules from `checkAskUserQuestionQuality` (options 2..4, `[tier]` prefix, context ≥ 80 chars, no forbidden meta labels, exactly one `(Recommended · N/M)` marker, non-empty question). Substitute the `{placeholders}` at call-site and call `mcp__model-command__run`.

| Caller | Template | Use case |
|--------|----------|----------|
| `local:z` phase1 | [z-phase1-plan-approval.json](./templates/z-phase1-plan-approval.json) | Plan confirmation before dispatching `local:zwork` |
| `local:z` phase2.9 | [z-phase2.9-pr-approval.json](./templates/z-phase2.9-pr-approval.json) | PR merge approval after `ztrace` briefing |
| `local:zcheck` Step 4 | [zcheck-pr-approve.json](./templates/zcheck-pr-approve.json) | PR approve with 4 RATE-scored options (+1 / −2 / −3 / −5) |
| `local:ztrace` Phase 0 | [ztrace-ambiguous-scenario.json](./templates/ztrace-ambiguous-scenario.json) | Scenario confirmation when user didn't provide a scenario list |
| `local:zexplore` | [zexplore-research-scope.json](./templates/zexplore-research-scope.json) | Research scope confirmation (narrow / as-is / broaden) |
| `local:decision-gate` tier=medium | [decision-gate-tier-medium.json](./templates/decision-gate-tier-medium.json) | Autonomous 3-reviewer vote vs user-ask branch |

**`local:zwork` does NOT own its own template.** When `zwork` needs user input during implementation, it routes through `local:decision-gate` (tier=medium) which then uses the `decision-gate-tier-medium.json` template. This keeps the "when to ask the user" decision in one place and prevents `zwork` from short-circuiting the gate.

## Key Principles

1. **`decision-gate` first** — Do not use this skill if it falls within the autonomous judgment area.
2. **Self-contained** — Tier, code, problem, options, and review consensus must all be included in `context`.
3. **Actionable Option A/B** — Selecting an option triggers immediate execution. No additional input required. The "Other" button is added automatically by Slack.
4. **Start from a caller template** — Six reference templates live under [`templates/`](./templates/). They pass both `validateModelCommandRunArgs` (hard gate) and `checkAskUserQuestionQuality` (soft gate, 0 warnings) — use them as starting points instead of hand-rolling payloads.
