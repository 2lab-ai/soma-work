---
description: "Search THIS codebase using Explore agent (Gemini). Find implementations, patterns, code flow."
argument-hint: "QUESTION"
allowed-tools:
  - Task
  - TaskOutput
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - mcp__llm__chat
---

**Always read commands body** even if you knew it.**

@include(${CLAUDE_PLUGIN_ROOT}/.commands-body/explore.md)
