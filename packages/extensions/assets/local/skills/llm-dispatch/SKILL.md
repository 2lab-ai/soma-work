---
name: llm-dispatch
description: "Primary pattern for harness-side long-running LLM dispatch. Drive codex via Bash(codex exec --json, run_in_background:true) + Monitor + TaskStop, with codex exec resume for continuation. Fallback to a single synchronous mcp__llm__chat with timeoutMs + resumeSessionId for non-codex models or when primary preflight fails. Triggered by: llm-dispatch, llm 디스패치, long-running llm."
---

# llm-dispatch — Long-Running LLM Dispatch

Two paths, one contract:

- **Primary** — `codex` only. `Bash(run_in_background:true)` + `Monitor` + `TaskStop`. Continuation via `codex exec resume --last`.
- **Fallback** — any model via a single synchronous `mcp__llm__chat` call. One retry on `BACKEND_TIMEOUT` via `resumeSessionId`. Used when primary preflight fails, or when `model != codex`.

The `model` is passed through unchanged. Dual-model callers invoke this skill once per model; it never fans out.

## When to use

- Sub-LLM turn ≥ 60s (deep research, long review, large refactor proposal).
- Persist the raw text of a single model turn to an artifact file.
- Cancel a running job on user correction (primary only — fallback is synchronous).
- Continue a prior `codex` turn via `codex exec resume --last`.

## When NOT to use

- Short prompt (< 10s). Call `mcp__llm__chat` directly.
- Multi-model orchestration. Belongs in the caller (e.g. `local:zdeepresearch`), which invokes this skill once per model.
- Codebase exploration. Use `local:explore` or `local:librarian`.

## Preflight gates

Run once per session and memoize. Binary PASS / FAIL each.

| Gate | Check | On FAIL |
|---|---|---|
| G-codex-bin | `which codex` returns a path | Fallback. |
| G-codex-version | `codex --version` ≥ 0.121 (needed for `exec resume`) | Fallback iff `resume:true`. |
| G-codex-auth | `codex exec --json --skip-git-repo-check 'ping' --output-last-message <tmp> < /dev/null` exits 0, file non-empty | Fallback. |
| G-network | Roundtrip via G-codex-auth (memoized) | Fallback. |
| G-bash-bg | `Bash(echo ok, run_in_background:true)` returns `task_id` and completion notification | Fallback. |
| G-monitor | `Monitor` on `for i in 1 2; do echo tick; sleep 1; done` emits ≥ 1 event | Non-fatal; completion notification still fires. |
| G-gh | `gh auth status` shows logged-in account | Dispatch proceeds; PR/issue side-effects are caller's concern. |

**Fallback precedence:** `{G-codex-bin, G-codex-auth, G-network, G-bash-bg}` is the one chain — any failure collapses to the MCP fallback. `G-codex-version` only gates `resume:true`; first-turn dispatches ignore it. `G-monitor` failure is non-fatal. `G-gh` gates side-effects, not dispatch.

## Process

### Phase 1: Dispatch

Inputs:

```
model:         <codex | other-model>   # pass-through; primary path requires codex
prompt:        <forged string>
timeout_min:   <int, default 10; fallback capped at 30 by mcp__llm__chat timeoutMs max=1800000ms>
artifact_path: <caller-supplied UNIQUE path, e.g. .claude/tasks/{sessionId}/{skill}/{slug}__{model}__{epoch}.raw.md>
resume:        false                   # primary only; continue previous codex turn
```

**`artifact_path` uniqueness contract:** the caller MUST supply a path that is unique per dispatch. Retry, concurrent runs, and same-topic re-runs each require a distinct path. The dispatcher does not de-dup.

Primary — taken only if `model == codex` AND the preflight chain passed:

1. Persist the prompt at `{artifact_path%.raw.md}__prompt.md`.
2. Build the command (close stdin with `< /dev/null` — codex otherwise hangs; pass `--skip-git-repo-check` unless in a trusted repo):
   - First turn: `codex exec --json --skip-git-repo-check <prompt> --output-last-message <artifact_path> < /dev/null > <artifact_path>.trace.ndjson 2>&1`
   - Continuation (`resume:true`, only after a prior **completed** codex turn): `codex exec resume --last --json --skip-git-repo-check <prompt> --output-last-message <artifact_path> < /dev/null > <artifact_path>.trace.ndjson 2>&1`
   - Launch via `Bash({ command: <above>, run_in_background: true })` → capture `task_id`.
3. Arm a `Monitor` on the trace file covering progress AND failure signatures:
   `tail -f <artifact_path>.trace.ndjson | grep -E --line-buffered "item.completed|turn.completed|error|Error|FAILED|Traceback|Killed|OOM"`.
4. Record `{task_id, artifact_path, model, started_at, timeout_min}` for Phase 2.

Fallback — primary not viable or `model != codex`:

1. Persist the prompt at `{artifact_path%.raw.md}__prompt.md` (same contract as primary).
2. Call `mcp__llm__chat({ model: <model>, prompt, timeoutMs: timeout_min * 60000 })`. Synchronous; returns `{ sessionId, backend, model, content }` on success or `structuredContent.error.code` on failure. `model` is the caller's value verbatim.
3. Record `{sessionId, artifact_path, model, started_at, timeout_min}` for Phase 2.

### Phase 2: Collect

Primary path:

1. Wait for the background-task completion notification. Do not sleep in a poll loop — the notification fires on its own.
2. On completion, declare `status=completed` iff ALL three: task exit code `== 0`, `<artifact_path>` exists and non-empty, trace contains `turn.completed`. Otherwise `status=failed` → step 4.
3. Artifact purity: `<artifact_path>` holds only the final assistant text (from `--output-last-message`). NDJSON lives in `<artifact_path>.trace.ndjson` and is NEVER merged into the artifact. Callers Read only `<artifact_path>`.
4. On `Monitor` emitting a failure signature, or on failure in step 2, invoke `TaskStop({task_id})` and mark `status=failed`.
5. On `timeout_min` elapsed without completion, invoke `TaskStop({task_id})` and mark `status=timeout`. **Timeout is terminal — do NOT continue via `resume`.** Retry is a fresh dispatch with a NEW `artifact_path`; caller decides whether to retry.

Fallback path (synchronous; no polling):

1. On success: write `content` to `<artifact_path>` (artifact purity applies), mark `status=completed`.
2. On `BACKEND_TIMEOUT`: one continuation via `mcp__llm__chat({ resumeSessionId: <sessionId>, prompt: "Please continue and finalize." })`. Success → write its `content`, `status=completed`; else `status=timeout`.
3. On any other error code (`BACKEND_FAILED`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `MUTUAL_EXCLUSION`, `INVALID_ARGS`, `ABORTED`): mark `status=failed` and surface the code.

### Phase 3: Return

```
{
  status:             "completed" | "failed" | "timeout" | "cancelled",
  path:               "primary" | "fallback",
  artifact_path:      "<absolute path to final text>",
  trace_path:         "<NDJSON path>"    // primary only; null on fallback
  task_or_session_id: "<id>",
  model:              "<the model passed in>",
  error_code:         "<code>"           // fallback failure only; omit on success
  started_at:         "<iso>",
  ended_at:           "<iso>"
}
```

Caller reads `artifact_path` for content. This skill never normalizes text.

### Cancellation on correction

Primary — caller MUST invoke `TaskStop({task_id})` **before** any new planning (INV-2 first-correction hard-stop). Fallback — synchronous call blocks until success or `timeoutMs`; no mid-call cancellation handle.

## Hard Rules

- [ ] Primary requires `model == codex` AND `{G-codex-bin, G-codex-auth, G-network, G-bash-bg}` PASS; `G-codex-version` PASS also required when `resume:true`. Any failure → fallback.
- [ ] `codex exec --json` always paired with `--output-last-message <file>`.
- [ ] Artifact purity: `<artifact_path>` holds only final text; NDJSON → `<artifact_path>.trace.ndjson`.
- [ ] Primary success = exit code 0 AND non-empty artifact AND `turn.completed` in trace.
- [ ] `Bash(..., run_in_background:true)` is the only sanctioned launch for a codex turn on the primary path.
- [ ] Every dispatch writes to a caller-supplied UNIQUE `artifact_path`.
- [ ] Primary cancellation requires `TaskStop` — never drop the reference.
- [ ] `codex exec resume --last` only after a prior **completed** codex turn. `timeout`/`failed`/`cancelled` turns → fresh dispatch.
- [ ] Fallback calls `mcp__llm__chat` synchronously exactly once per dispatch; one continuation via `resumeSessionId` only on `BACKEND_TIMEOUT`.
- [ ] Fallback `timeoutMs` ≤ 1800000ms (schema max); caller SHOULD set explicitly.
- [ ] Fallback passes the caller's `model` through verbatim — never hardcode.
- [ ] `resumeSessionId` mutually exclusive with `model`/`config` (`MUTUAL_EXCLUSION`).

## Anti-patterns

- `codex exec` without `--json` → brittle stdout tail.
- `codex exec --json` without `--output-last-message` → forces NDJSON parsing.
- Background `codex exec` without `< /dev/null` → hangs on "Reading additional input from stdin…".
- `codex exec` outside a trusted repo without `--skip-git-repo-check` → "Not inside a trusted directory".
- `run_in_background:false` for a long codex turn → UI blocked.
- Tight `sleep` poll on a background `Bash` task → use completion notification.
- Monitor filter covering only success signatures → silent crashes; MUST include `error|FAILED|Traceback|Killed|OOM`.
- Dropping `task_id` on correction without `TaskStop` → process leak, stale output next turn.
- Mixing primary + fallback in one dispatch → pick one up-front.
- Passing `background:true` to `mcp__llm__chat` → schema-rejected (`additionalProperties:false`), `INVALID_ARGS`.
- Hardcoding `model: "codex"` in the fallback call → breaks non-codex dispatch silently.
- `codex exec resume --last` without verifying prior turn completed → resumes cancelled/failed/timed-out state.
- Retrying a timed-out primary turn with `resume: true` → rebinds `--last` or fails; always fresh dispatch with NEW `artifact_path`.
- Retrying fallback `BACKEND_TIMEOUT` twice, or retrying any other error via `resumeSessionId` → violates single-continuation rule.
- Combining `resumeSessionId` with `model` or `config` → `MUTUAL_EXCLUSION`.
- Merging NDJSON into the artifact → poisons summarization.
- Reusing a stale `artifact_path` on retry → partial writes indistinguishable from retry output.
- **`ScheduleWakeup` 금지**: 불러도 미복귀. 장기 폴링은 primary path(`Bash(run_in_background:true)` + `Monitor` + `TaskStop`) 또는 fallback의 `mcp__llm__chat(timeoutMs, resumeSessionId)`로 해결.

**Authoring:** SKILL.md ≤ 10 KB (target <9 KB). Runtime-soft; CI/review enforces.
