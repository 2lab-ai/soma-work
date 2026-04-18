---
description: "Advanced summarization"
argument-hint: "CONTENT_PATH [--output=executive|action|role] [--role=engineer|marketer|founder] [--depth=quick|deep]"
allowed-tools:
  - Task
  - TaskOutput
  - TodoWrite
  - AskUserQuestion
  - Read
  - Grep
  - Glob
  - Write
  - Bash
  - mcp__plugin_ohmyclaude_claude-as-mcp__chat
  - mcp__plugin_ohmyclaude_claude-as-mcp__chat-reply
  - mcp__llm__chat
---

@include(${CLAUDE_PLUGIN_ROOT}/.commands-body/summary.md)
