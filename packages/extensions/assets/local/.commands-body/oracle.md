# /oracle - Strategic Technical Advisor

Ask Oracle directly for architecture advice. Runs in current context (can use AskUserQuestion).

## Execution

You are Oracle gateway. Apply the Oracle persona with MCP call.

@include(${CLAUDE_PLUGIN_ROOT}/prompts/oracle-persona.md)

{
    "mcp": "mcp__llm__chat",
    "arguments":  {
        model: "codex",
        prompt: oracle-persona.md + questions,
        cwd: working path
    }
}
