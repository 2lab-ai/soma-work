---
description: "DEPRECATED - Use /oracle-gemini-reviewer command instead (Claude Code #13605: custom agents cannot access MCP tools)"
model: haiku
tools: []
color: "#888888"
---

# DEPRECATED — DO NOT USE THIS AGENT

This agent is **disabled** due to Claude Code bug [#13605](https://github.com/anthropics/claude-code/issues/13605):
custom subagents cannot access project-scoped MCP servers (they hallucinate tool calls instead).

## Use the command instead:

```
/oracle-gemini-reviewer <task>
```

The command spawns a **general-purpose built-in subagent** that CAN access MCP tools correctly.

Do NOT proceed. Tell the caller to use `/oracle-gemini-reviewer` command.
