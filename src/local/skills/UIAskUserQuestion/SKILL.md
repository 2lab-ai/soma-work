---
description: Output structured JSON choices when user decision is needed
allowed-tools: Read, Grep, Glob
---

# UIAskUserQuestion - Structured User Choice Interface

When your turn ends and user input is required, provide structured JSON output so users can respond by number.

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
  options: UserChoiceOption[];   // 2-5 actionable options
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

- You should include all CONTEXT in that question. Do not let the user scroll up with saying "WHAT THE FUCK IT IS GOING TO DOING?".
- User should know what will you do if the option chosen by the user.

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
  "type": "user_choice_group",
  "question": "How should we implement the caching layer?",
  "context": "The API currently makes redundant database calls. Caching will improve response times.",
  "choices": [
    {
      "type": "user_choice",
      "question": "Which caching strategy?",
      "options": [
        { "id": "1", "label": "Redis cache", "description": "Distributed, persistent, requires infrastructure" },
        { "id": "2", "label": "In-memory cache", "description": "Fast, simple, lost on restart" },
        { "id": "3", "label": "Both with fallback", "description": "Redis primary, memory fallback. More complex." }
      ]
    },
    {
      "type": "user_choice",
      "question": "Cache invalidation strategy?",
      "options": [
        { "id": "1", "label": "TTL-based", "description": "Simple, eventual consistency" },
        { "id": "2", "label": "Event-driven", "description": "Immediate consistency, more complex" }
      ]
    }
  ]
}
```

## Key Principle

Every option must be **actionable** - selecting it should allow work to proceed immediately without requiring additional user input.
