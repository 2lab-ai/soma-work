---
description: "Use when external documentation, library APIs, best practices or open-source source code must be looked up."
argument-hint: "QUESTION"
allowed-tools:
  - Agent
  - Task
  - Skill
  - TaskOutput
  - Read
  - Grep
  - Glob
  - Bash
  - WebSearch
  - WebFetch
  - AskUserQuestion
  - mcp__plugin_context7_context7__resolve-library-id
  - mcp__plugin_context7_context7__query-docs
---

**Always read commands body** even if you knew it.**

@include(${CLAUDE_PLUGIN_ROOT}/.commands-body/librarian.md)
