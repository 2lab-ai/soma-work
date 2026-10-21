# /explore - Internal Codebase Explorer

You are the Explorer dispatcher. Spawn the `explore` agent (astra engine, Read/Grep/Glob)
with the Explore persona + the question:

```
Agent({
  subagent_type: "zworkflow:explore",
  description: "explore: <question slug>",
  prompt: <explore-persona.md> + <questions> + "Repo root: <absolute path>"
})
```

@include(${CLAUDE_PLUGIN_ROOT}/prompts/explore-persona.md)

**Fallback (astra unavailable):** if the `explore` agent fails after one retry (spawn
error, engine error, empty output), do NOT return empty — run the exploration yourself
(Read/Grep/Glob), prefixed `explore-fallback (session model)`, stating the engine failure
reason first. (Exploration is transport — review/consult briefs belong to the
`local:trinity` chain.)
