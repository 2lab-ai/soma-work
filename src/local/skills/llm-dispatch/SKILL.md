---
name: llm-dispatch
description: "Harness-side long-running external-model dispatch. Spawns one zworkflow subagent (astra-zhuge / grok-elon / fable-zhuge / astra-elon / strategist) via Agent(run_in_background:true), persists the raw turn to a caller-supplied artifact, and returns a completion envelope. Continuation via SendMessage to the same agent; cancellation via TaskStop. External engines are reached ONLY through the subagent's frontmatter model — the former CLI and MCP chat transports are retired (2026-09-30). Triggered by: llm-dispatch, llm 디스패치, long-running llm."
---

# llm-dispatch — Long-Running Subagent Dispatch

One path, one contract:

- **Transport** — `Agent({ subagent_type: "zworkflow:<agent>", prompt, run_in_background: true })`. `<agent>` is one of `astra-zhuge` (astra) / `grok-elon` (grok) / `fable-zhuge` (fable) / `astra-elon` (astra) / `strategist` (session model). The caller picks the agent; this skill never substitutes engines.
- **Continuation** — `SendMessage({ to: <agent-name>, message })` on a prior **completed** turn (context preserved).
- **Cancellation** — `TaskStop({ task_id: <agent-name or id> })`.

> **Chain position.** This skill is TRANSPORT. Judgment/review/consult gates route through `local:trinity` first (3-agent panel → single-panelist fallback `astra-zhuge` → `grok-elon` → `fable-zhuge`); this skill is how one long-running panelist turn gets executed. Do not use it to bypass that chain.

## When to use

- Sub-LLM turn ≥ 60s (deep research, long review, large refactor proposal).
- Persist the raw text of a single agent turn to an artifact file.
- Cancel a running job on user correction.
- Continue a prior turn of the same agent.

## When NOT to use

- Short prompt (< 10s). Call `Agent(...)` in the foreground; no artifact needed.
- Multi-agent orchestration. Belongs in the caller (e.g. `local:zdeepresearch`, `local:trinity`), which invokes this skill once per agent.
- Codebase exploration. Use `local:explore` or `local:librarian`.

## Preflight gates

Run once per session and memoize. Binary PASS / FAIL each.

| Gate | Check | On FAIL |
|---|---|---|
| G-agent | `<agent>.md` exists in the zworkflow agents dir (`${CLAUDE_PLUGIN_ROOT}/agents/`) | `status=failed`, `error_code=UNKNOWN_AGENT`. Never substitute. |
| G-engine | non-anthropic agent (astra / grok, served via llmux): a one-line probe turn (`reply PONG`) returns non-empty | `status=failed`, `error_code=ENGINE_UNAVAILABLE` → caller degrades per the trinity chain. |
| G-bash-bg | `Bash(echo ok, run_in_background:true)` returns `task_id` and a completion notification | `status=failed`, `error_code=NO_WATCHDOG` — without a background timer `timeout_min` cannot be enforced (see Phase 1 step 4). |
| G-gh | `gh auth status` shows logged-in account | Dispatch proceeds; PR/issue side-effects are caller's concern. |

## Process

### Phase 1: Dispatch

Inputs:

```
agent:         <astra-zhuge | grok-elon | fable-zhuge | astra-elon | strategist>
prompt:        <forged string>
timeout_min:   <int, default 10>
artifact_path: <caller-supplied UNIQUE path, e.g. .claude/tasks/{sessionId}/{skill}/{slug}__{agent}__{epoch}.raw.md>
resume:        false                   # continue a previous COMPLETED turn of the same agent
```

**`artifact_path` uniqueness contract:** the caller MUST supply a path that is unique per dispatch. Retry, concurrent runs, and same-topic re-runs each require a distinct path. The dispatcher does not de-dup.

1. Persist the prompt at `{artifact_path%.raw.md}__prompt.md`.
2. Append the **artifact clause** to the prompt (mandatory): `Write your complete final answer — and nothing else — to <artifact_path> with the Write tool, then reply with the single line "DONE <artifact_path>".` The agent writes the artifact itself; its chat reply is only a signal.
3. Launch:
   - First turn: `Agent({ subagent_type: "zworkflow:<agent>", description: "<skill>: <slug>", prompt, run_in_background: true })` → capture the agent name / id from the result.
   - Continuation (`resume:true`, only after a prior **completed** turn): `SendMessage({ to: <agent-name>, message: prompt })`.
4. **Start the timeout watchdog in the same message** (the `Agent` tool has no timeout argument, and polling / `ScheduleWakeup` are forbidden — this timer is the ONLY thing that wakes the caller on a hung agent): `Bash("sleep " + timeout_min*60 + "; echo LLM_DISPATCH_TIMEOUT <agent_id>", run_in_background: true)` → capture `watchdog_task_id`.
5. Record `{agent_id, watchdog_task_id, artifact_path, agent, started_at, timeout_min}` for Phase 2.

### Phase 2: Collect

1. Wait for whichever background notification arrives first: the agent's completion or the watchdog's `LLM_DISPATCH_TIMEOUT`. Do not sleep in a poll loop — notifications fire on their own. (`ScheduleWakeup` 금지 — 불러도 미복귀.) On agent completion, `TaskStop({ task_id: watchdog_task_id })` so the timer cannot fire later.
2. On completion, declare `status=completed` iff BOTH: the notification reports success, and `<artifact_path>` exists and is non-empty. If the agent answered but did not write the artifact, write its final message to `<artifact_path>` yourself (artifact purity: final text only, no progress chatter).
3. Notification reports failure, or the reply is empty / a raw engine error → `status=failed`, surface the agent's error text as `error_code=AGENT_FAILED`.
4. Watchdog fires first (agent still running) → `TaskStop({ task_id: agent_id })` and mark `status=timeout`. **Timeout is terminal — do NOT continue via `resume`.** Retry is a fresh dispatch with a NEW `artifact_path`; the caller decides whether to retry.

### Phase 3: Return

```
{
  status:             "completed" | "failed" | "timeout" | "cancelled",
  agent:              "<the agent passed in>",
  artifact_path:      "<absolute path to final text>",
  task_or_session_id: "<agent name / id>",
  error_code:         "UNKNOWN_AGENT" | "ENGINE_UNAVAILABLE" | "NO_WATCHDOG" | "AGENT_FAILED"   // failure only; omit on success
  started_at:         "<iso>",
  ended_at:           "<iso>"
}
```

Caller reads `artifact_path` for content. This skill never normalizes text.

### Cancellation on correction

Caller MUST invoke `TaskStop({task_id})` **before** any new planning (INV-2 first-correction hard-stop). Never drop the reference.

## Hard Rules

- [ ] Engine reach = the subagent's frontmatter `model` only. No CLI, no MCP chat tool.
- [ ] Every dispatch is exactly one `Agent` call with `run_in_background: true` (or one `SendMessage` when `resume:true`).
- [ ] The caller's `agent` is passed through verbatim — never substitute; `UNKNOWN_AGENT` / `ENGINE_UNAVAILABLE` go back to the caller, who owns the trinity fallback order.
- [ ] Artifact purity: `<artifact_path>` holds only the final answer text.
- [ ] Every dispatch writes to a caller-supplied UNIQUE `artifact_path`.
- [ ] `resume:true` only after a prior **completed** turn of the same agent. `timeout` / `failed` / `cancelled` turns → fresh dispatch.
- [ ] Cancellation requires `TaskStop` — never drop the reference.
- [ ] Dispatched agents must not spawn further agents or panels (fan-out hygiene; the trinity isolation contract applies).

## Anti-patterns

- Foreground `Agent` for a ≥ 60s turn → UI blocked.
- Tight `sleep` poll on a background task → use the completion notification.
- Silently swapping `astra-zhuge` for `fable-zhuge` inside this skill → forges the audit tier; the caller orders the fallback.
- Dropping the agent handle on correction without `TaskStop` → orphaned run, stale output next turn.
- Reusing a stale `artifact_path` on retry → partial writes indistinguishable from retry output.
- Merging progress chatter into the artifact → poisons summarization.
- Retrying a timed-out turn with `resume: true` → resumes a dead context; always fresh dispatch with a NEW `artifact_path`.
- Reintroducing a CLI or MCP transport "for speed" → two engine paths, two failure modes, one audit trail broken.

**Authoring:** SKILL.md ≤ 10 KB (target <9 KB). Runtime-soft; CI/review enforces.
