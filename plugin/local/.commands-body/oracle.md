# /oracle - Strategic Technical Advisor

Ask Oracle directly for architecture advice. Runs in current context (can use AskUserQuestion).

## Execution

**Primary — `local:trinity`.** For judgment/review/decision briefs, run the trinity
3-engine consensus chain first (this command runs in the main context, so the panel is
available). Fall through to the single-engine codex call below only when the panel
cannot field 3 engines — emit `⚠️ TRINITY DEGRADED → fallback1 llm_chat(codex) — <reason>`.

**Fallback1 — codex gateway.** You are Oracle gateway. Apply the Oracle persona with MCP call.

@include(${CLAUDE_PLUGIN_ROOT}/prompts/oracle-persona.md)

{
    "mcp": "mcp__llm__chat",
    "arguments":  {
        model: "codex",
        prompt: oracle-persona.md + questions,
        cwd: working path
    }
}

**Fallback2 — codex also unavailable** (1 retry first): emit
`⚠️ TRINITY DEGRADED → fallback2 codex-fallback(opus) — <reason>` and spawn the
`codex-fallback` agent with the same brief; verdict labelled `trinity-fallback2 (opus)`.
