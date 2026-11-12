---
description: "Use when a multi-part task should be coordinated across the Oracle, Explore and Librarian agents in the current context."
argument-hint: "TASK"
allowed-tools:
  - Agent
  - Task
  - Skill
  - TaskOutput
  - TodoWrite
  - AskUserQuestion
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash
  - mcp__plugin_ohmyclaude_claude-as-mcp__chat
  - mcp__plugin_ohmyclaude_claude-as-mcp__chat-reply
---

**Always read commands body** even if you knew it.**

@include(${CLAUDE_PLUGIN_ROOT}/.commands-body/orchestrator.md)
