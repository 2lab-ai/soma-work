# /oracle - Strategic Technical Advisor

Ask Oracle directly for architecture advice. Runs in current context (can use AskUserQuestion).

## Execution

**Primary — `local:trinity`.** For judgment/review/decision briefs, run the trinity
3-agent consensus panel (`astra-zhuge` / `grok-elon` / `fable-zhuge`) first — this command
runs in the main context, so the panel is available. Fall through to the single-engine
dispatch below only when the panel cannot field 3 engines — emit
`⚠️ TRINITY DEGRADED → fallback single-panelist(<agent>) — <reason>`.

**Fallback — single panelist subagent.** Send the Oracle persona + the question to ONE
subagent, in fixed order `astra-zhuge` → `grok-elon` → `fable-zhuge` (advance only when
the previous agent is unusable after one retry: spawn failure, timeout, empty output).
Label the verdict `trinity-fallback (<agent>)`.

```
Agent({
  subagent_type: "zworkflow:astra-zhuge",      // → "zworkflow:grok-elon" → "zworkflow:fable-zhuge"
  description: "oracle consult",
  prompt: <oracle-persona.md> + <question> + "Working path: <absolute repo root>"
})
```

@include(${CLAUDE_PLUGIN_ROOT}/prompts/oracle-persona.md)

**All three unavailable:** report the raw failures and stop — never answer the consult
yourself under a fallback label (that would forge the audit tier).
