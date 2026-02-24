---
description: Send user-choice questions through model-command tool (fallback: structured JSON)
allowed-tools: Read, Grep, Glob, mcp__model-command__list, mcp__model-command__run
---

# UIAskUserQuestion - Structured User Choice Interface

When your turn ends and user input is required, use model-command tool first.

## Primary Action (Tool-first)

Call:

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice",
      "question": "Your question",
      "choices": [
        { "id": "1", "label": "Option A", "description": "Tradeoff of A" },
        { "id": "2", "label": "Option B", "description": "Tradeoff of B" }
      ]
    }
  }
}
```

- Use `mcp__model-command__run` with the payload above.
- Use `mcp__model-command__list` first if command availability is unclear.

## Fallback Output (Only if tool unavailable)

If model-command tool is unavailable, output structured JSON so users can respond by number.

## Output Format

When a concrete technical decision is needed, output a `UserChoiceGroup`:

```json
{
  "type": "user_choice_group",
  "question": "Overall context question",
  "context": "Why these decisions are needed",
  "choices": [
    {
      "type": "user_choice",
      "question": "Specific technical question",
      "context": "Why this decision matters",
      "options": [
        { "id": "1", "label": "Option A", "description": "Tradeoffs of A" },
        { "id": "2", "label": "Option B", "description": "Tradeoffs of B" }
      ]
    }
  ]
}
```

## TypeScript Interfaces

```typescript
interface UserChoice {
  type: 'user_choice';
  question: string;              // Specific technical question
  options: UserChoiceOption[];   // 2-4 actionable options (Slack UI button limit)
  context?: string;              // Why this decision is needed
}

interface UserChoiceOption {
  id: string;           // "1", "2", etc.
  label: string;        // Concrete action (e.g., "Use Redis", "Split function")
  description?: string; // Tradeoffs of this choice
}

interface UserChoiceGroup {
  type: 'user_choice_group';
  question: string;              // Context for all choices
  choices: UserChoice[];
  context?: string;              // Why these decisions are needed
}
```

## Rules

- Always use review with **`oracle-reviewer` Skill**, **`oracle-gemini-reviewer`** Skill togather in paralel if you don't have any review with this choices.

- You should include all CONTEXT in that question. Do not let the user scroll up with saying "WHAT THE FUCK IT IS GOING TO DOING?".
- User should know what will you do if the option chosen by the user.
- Slack UI renders up to 4 options as buttons (plus 1 "custom input" button). Keep options to **2-4**.

### USE UserChoice when:
- Implementation choice: "Redis vs In-memory cache?"
- Architecture decision: "Monolithic vs Microservices?"
- Refactoring options: "Extract function vs Extract class?"
- PR review actions: "P0 fix-way #1 or fix-way #2 or #3? (with detailed how to fix description) + thqt review source url link"
- Concrete next steps with clear outcomes

### DO NOT use UserChoice when:
- Context is unclear - ask plain text instead
- Open-ended questions like "How can I help?"
- "About this image/file..." without specific context
- Guessing user intent with speculative options

### When context is unclear:
Ask directly in plain text:
- "What task do you want to perform?"
- "How should I process this file?"

## Bad Examples (NEVER do these)

```json
// BAD - Requires additional input, button does nothing useful
{
  "id": "1",
  "label": "Provide PR link for full review",
  "description": "If you have a GitHub PR, share the link for complete context"
}

// BAD - Meaningless action, just asks for more info
{
  "id": "2",
  "label": "Explain context",
  "description": "Tell me why you shared this image"
}
```

## Good Examples

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice_group",
      "question": "Summary title (e.g., 'PR #123 — 2 unresolved feedback items')",
      "context": "Overall status summary (what's already resolved, how many remain)\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 Issue 1: [Priority] Title\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n▸ Current problem:\nProblem description + code snippet\n```lang\n// problematic code\n```\n\n▸ Impact: Actual behavior caused by this problem\n\n▸ Required changes:\nFix approach + example code\n```lang\n// fix code example\n```\nChange scope summary (number of files, difficulty)\n\n▸ 🤖 Codex opinion:\nAI analysis (recommended direction, risk, rationale)\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 Issue 2: [Priority] Title\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n(same structure repeated)",
      "choices": [
        {
          "question": "[Priority] Issue title — change scope summary (difficulty hint)",
          "options": [
            {
              "id": "issue1_fix",
              "label": "Fix in this PR (Recommended)",
              "description": "Specific changes: which files, what modifications, how"
            },
            {
              "id": "issue1_defer",
              "label": "Defer to followup issue",
              "description": "Create separate issue + PR comment explaining out-of-scope"
            },
            {
              "id": "issue1_skip",
              "label": "Skip",
              "description": "Reason or condition for not fixing"
            }
          ]
        },
        {
          "question": "[Priority] Issue title — change scope summary (difficulty hint)",
          "options": [
            {
              "id": "issue2_fix",
              "label": "Fix",
              "description": "Specific changes"
            },
            {
              "id": "issue2_skip",
              "label": "Skip",
              "description": "Do not fix"
            },
            {
              "id": "issue2_defer",
              "label": "Create followup issue",
              "description": "Track in separate issue"
            }
          ]
        }
      ]
    }
  }
}

```

## Key Principle

Every option must be **actionable** - selecting it should allow work to proceed immediately without requiring additional user input.
