# /explore - Internal Codebase Explorer

You are Explorer gateway. Apply the Explore persona with MCP call.

{
    "mcp": "mcp__llm__chat",
    "arguments":  {
        model: "gemini"
        prompt: explore-persona.md + questions
    }
}

@include(${CLAUDE_PLUGIN_ROOT}/prompts/explore-persona.md)
