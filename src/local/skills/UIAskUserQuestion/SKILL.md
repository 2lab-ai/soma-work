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
      "choices": [
        { "id": "1", "label": "Option A: <action> (Recommended · 3/3)", "description": "<trade-offs>" },
        { "id": "2", "label": "Option B: <action>",                     "description": "<trade-offs>" }
      ]
    }
  }
}
```

If multiple decisions are bundled, use `type: "user_choice_group"` + `choices: [{question, options:[...]}]` array.

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
5. **Recommended option goes first** — Mark in label with `(Recommended · N/M)`. N/M is the review vote count.
6. **Actionable label** — Specific action that can be executed immediately upon selection. Meta options like "I'll think about it" are prohibited.
7. **Do not mention `plan` in Plan mode** — The user cannot see the plan in the UI. Plan approval is the responsibility of `ExitPlanMode`; this tool is for confirming requirements.
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
      "choices": [
        {
          "id": "option_a",
          "label": "Option A: Add when filter (Recommended · 3/3)",
          "description": "`catch (DbUpdateException ex) when (IsDuplicateKeyException(ex))` — Bulk update 4 files, add 4 tests. Minimal change, intuitive."
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

## Key Principles

1. **`decision-gate` first** — Do not use this skill if it falls within the autonomous judgment area.
2. **Self-contained** — Tier, code, problem, options, and review consensus must all be included in `context`.
3. **Actionable Option A/B** — Selecting an option triggers immediate execution. No additional input required. The "Other" button is added automatically by Slack.
