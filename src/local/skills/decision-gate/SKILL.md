---
name: decision-gate
description: A gate that decides between autonomous judgment and user questions based on switching cost. Used in all situations requiring a decision.
---

# Decision Gate — Autonomous Judgment vs User Question Discriminator

## Core Principle

**Maximize autonomous judgment. Only ask about things that are hard to reverse later.**

For every technical decision, estimate "How many lines would I need to change to reverse this later?" (switching cost), then act according to that tier.

## Switching Cost Tiers

| Tier   | Lines  | Examples                              |
|--------|--------|---------------------------------------|
| tiny   | ~5     | Config values, constants, string literals |
| small  | ~20    | Single function, single file, local refactor |
| medium | ~50    | Multiple files, interface changes      |
| large  | ~100   | Cross-cutting concerns, schema migrations |
| xlarge | ~500   | Architecture transitions, framework replacements |

## Decision Algorithm

```
for each decision:
  1. Estimate switching_cost = how many lines to change if reversing this decision later?

  2. if switching_cost < small (~20 lines):
       → Autonomous judgment
       → 3-person review majority vote (you + oracle-reviewer + oracle-gemini-reviewer)
       → Proceed in the direction agreed upon by 2/3 or more
       → Do not ask the user

  3. elif switching_cost >= medium (~50 lines):
       → Ask the user
       → Present 3-person review results + recommendation together
       → [tier ~N lines] notation required in the question
       → Use UIAskUserQuestion Skill
```

## 3-Person Majority Review (MANDATORY)

**Every decision (whether autonomous or a question) must be reviewed by 3 people:**

| Reviewer | Role |
|----------|------|
| Yourself | 1 vote — Judgment based on codebase context |
| `oracle-reviewer` Skill | 1 vote — Review from architecture/pattern perspective |
| `oracle-gemini-reviewer` Skill | 1 vote — Review from alternative perspective |

**Making decisions or asking questions without review is prohibited.**

### Autonomous Judgment (switching cost < small)

Proceed immediately in the direction agreed upon by 2 or more out of 3. Leave a decision log:

```markdown
### Auto-Decision: [Title]
- **Decision**: [Chosen option]
- **switching cost**: [tier] (~N lines)
- **Votes**: Codex ✅ / oracle-reviewer ✅ / oracle-gemini ❌ (2/3)
- **Rationale**: [Why this direction, 1-2 lines]
```

### User Question (switching cost >= medium)

Include the 3-person review results in the question:

```markdown
▸ 🤖 Review Consensus (2/3 recommend Option A):
  - Codex: Option A — [reason]
  - oracle-reviewer: Option A — [reason]
  - oracle-gemini: Option B — [reason]
```

## Required Elements When Asking the User

1. **`[tier ~N lines]` prefix** — Immediately convey the weight of the decision
2. **Current state** — Include code snippets
3. **Problem/reason** — Actual impact (performance? stability? data loss?)
4. **Specific actions for each option** — Which files, what changes, workload
5. **Trade-offs** — Pros, cons, risks
6. **Review consensus** — 3-person vote results + recommendation

```
"[medium ~50 lines] P1-1: DbUpdateException filter — modify catch pattern in 4 files"
"[large ~100 lines] Introduce cache layer — Redis vs In-memory"
"[xlarge ~500 lines] Auth architecture transition — JWT vs Session"
```

## Reference Table: Default Tier by Category

### Autonomous Judgment Area (switching cost < small)

| Category | Tier | Why |
|----------|------|-----|
| Variable/function names | tiny | Instantly changeable with refactoring tools |
| File location/structure | small | Easily reorganized |
| UI styling | tiny | Cosmetic, instantly changeable |
| Error message text | tiny | String literals |
| Config values | tiny | Environment variables/config files |
| Implementation approach within a single function | small | Local refactor |

### User Question Area (switching cost >= medium)

| Category | Tier | Example |
|----------|------|---------|
| Data model/schema | large~xlarge | SQL vs NoSQL, table design |
| Architecture patterns | large~xlarge | Microservices vs monolith |
| Major library selection | medium~large | ORM A vs B |
| Security approach | large | OAuth provider, encryption |
| Deployment model | xlarge | Serverless vs VPS |
| Interface spanning multiple files | medium | Shared type design |

## When to Use

This skill is not called directly — it is **always referenced** when a decision is needed:

- `UIAskUserQuestion` — Pass through this gate before creating a question for the user
- `new-task` Phase 3 — Use this gate for autonomous/question determination during ambiguity resolution
- Code review — Use this gate for **implementation approach selection** per issue (not Fix/Defer/Skip, but "which approach to use for the fix")
- General work — Use this gate when choosing an implementation approach

## NEVER

- Make decisions without review
- Ask the user without review
- Ask the user without tier notation
- "Just ask" without estimating switching cost
