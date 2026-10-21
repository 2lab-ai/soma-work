---
description: "Search THIS codebase using the Explore agent (astra engine). Find implementations, patterns, code flow."
argument-hint: "QUESTION"
allowed-tools:
  - Agent
  - Task
  - Skill
  - TaskOutput
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

**Always read commands body** even if you knew it.**

@include(${CLAUDE_PLUGIN_ROOT}/.commands-body/explore.md)
