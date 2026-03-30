---
description: "Generate multi-perspective PR Executive Summary for stakeholders"
argument-hint: "PR_NUMBER_OR_URL [--stakeholders=auto|all] [--format=markdown|slack]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Task
  - TaskOutput
  - TodoWrite
  - AskUserQuestion
  - Skill
  - mcp__github__get_pull_request
  - mcp__github__get_pull_request_reviews
  - mcp__github__get_pull_request_comments
  - mcp__github__get_pull_request_files
  - mcp__llm__chat
  - mcp__llm__chat-reply
---

@include(${CLAUDE_PLUGIN_ROOT}/.commands-body/pr-summary.md)
