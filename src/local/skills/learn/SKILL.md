---
name: learn
description: "Self-reflection on the current conversation. Extracts learnings, identifies mistakes, and saves durable facts to persistent memory via SAVE_MEMORY."
---

# learn — Conversation Self-Reflection & Memory

Inspired by hermes-agent's `flush_memories()` pattern: before a session ends or at any deliberate pause, review what happened, extract value, and persist it.

This is NOT `zreflect` (which only fires on re-instruction). This is a **proactive** skill — triggered explicitly to mine the conversation for durable learnings.

## When to Trigger

- End of a significant work session
- After completing a complex task
- When the user explicitly asks to learn/reflect
- Before a session reset or context compaction

## Process

### 1. Conversation Replay

Read the **entire thread** using `get_thread_messages` (all messages, not just recent).
Build a mental model of:
- What was the user's original intent?
- What actions were taken?
- What succeeded on the first try vs. required iteration?
- Where did misunderstandings or errors occur?

### 2. Self-Reflection Analysis

Produce a structured reflection:

```markdown
## Reflection Report

### What went well
- [Specific action that was efficient or correct]

### What went wrong
- [Specific mistake, misunderstanding, or wasted effort]
- Root cause: [Why it happened — wrong assumption? missed context? tool misuse?]

### Key decisions made
- [Decision]: [Why it was made, what alternatives existed]

### User preferences observed
- [Any implicit or explicit preference about workflow, style, communication]
```

### 3. Extract Durable Facts

From the reflection, identify facts that will **still be true next session**.

**Priority order** (hermes-agent flush_memories pattern — save higher priority first when space is limited):
1. User corrections (things the user explicitly corrected)
2. User preferences / style (communication, workflow, tool choices)
3. Recurring patterns (repeated behaviors, common mistakes to avoid)
4. Project conventions (coding style, architecture decisions, naming)
5. Environment discoveries (tool quirks, CI details, infrastructure)

| Category | Example | Save Target |
|----------|---------|-------------|
| User correction | "User said: do analysis first, not implementation" | `user` |
| User preference | "User prefers Korean responses" | `user` |
| Technical convention | "soma-work uses vitest not jest" | `memory` |
| Environment detail | "CI runs on GitHub Actions" | `memory` |
| Tool quirk | "gh CLI needs --repo flag in subagent" | `memory` |
| Workflow pattern | "User uses $z for all task dispatch" | `user` |

**Do NOT save:**
- Task progress or session outcomes (ephemeral)
- Information already in MEMORY (check with GET_MEMORY first)
- Obvious facts derivable from the codebase

### 4. Save to Memory

1. Call `GET_MEMORY` to read current memory state.
2. For each new durable fact:
   - If it's genuinely new: `SAVE_MEMORY` with `action: "add"`, appropriate `target`
   - If it updates an existing entry: `SAVE_MEMORY` with `action: "replace"`
   - If an existing entry is now wrong: `SAVE_MEMORY` with `action: "remove"`
3. Keep entries **compact** — memory has a char limit. One fact per entry, no filler.

### 5. Output Summary

Report to the user:

```markdown
## Learn Summary

**Conversation reviewed**: [message count] messages
**Reflection**: [1-2 sentence summary of what was learned]
**Memory changes**:
- Added: [count] entries
- Updated: [count] entries
- Removed: [count] entries
**Memory usage**: [X]% ([chars]/[limit])
```

## Rules

- **Never fabricate learnings.** Only save what actually happened in the conversation.
- **Bias toward removal.** If memory is >80% full, remove stale entries before adding new ones.
- **One fact per entry.** Do not bundle multiple facts into one memory entry.
- **No decoration.** Memory entries are injected into every future prompt. Keep them terse.
- **Check before saving.** Always GET_MEMORY first to avoid duplicates.
