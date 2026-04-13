---
name: zreflect
description: "Self-reflection when re-instruction detected. Analyzes gap between user's instruction and prior actions, produces reflection report."
---

# zreflect — Self-Reflection

**Only invoked when the instruction is NOT the first one in the session.**

When the user gives a follow-up or repeated instruction, something went wrong in the prior attempt. This skill forces a structured gap analysis before resuming work.

## Process

1. **Read back the user's instruction exactly as given.** If you just regurgitate the SSOT, you're dead — quote the literal words.
2. **Output an executive summary** of the work done so far in this session.
3. **Re-read the entire thread conversation** to determine:
   - Why the user had to give the instruction again
   - What was different between the user's instruction and your actions
   - What you failed to follow
4. **Write a self-reflection report** as an `.md` file and send it to the user. The report must include:
   - The exact instruction (quoted)
   - What was done vs. what should have been done
   - Root cause of the gap (misunderstanding? skipped step? wrong assumption?)
   - Corrective action for the remainder of this session
5. **Submit this self-reflection to `llm_chat(codex)` for evaluation**, relay the feedback to the user, reflect on it, and then resume normal work.

## When NOT to invoke

- First instruction in the session — skip entirely, proceed to phase0.
- User explicitly says "continue" or "proceed" without correction — no reflection needed.
