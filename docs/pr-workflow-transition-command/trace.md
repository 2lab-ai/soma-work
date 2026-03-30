# PR Workflow Transition Command & Merge Gate — Vertical Trace

> STV Trace | Created: 2026-03-10
> Spec: docs/pr-workflow-transition-command/spec.md

## Table of Contents
1. [Scenario 1 — `CONTINUE_SESSION` model-command contract](#scenario-1)
2. [Scenario 2 — Host continuation executes reset + forced workflow handoff](#scenario-2)
3. [Scenario 3 — `pr-review` waits on CI and routes failures into fix decisions](#scenario-3)
4. [Scenario 4 — Merge gate question replaces direct merge shortcut](#scenario-4)
5. [Scenario 5 — `pr-fix-and-update` auto-recurses into `pr-review`](#scenario-5)

---

## Scenario 1 — `CONTINUE_SESSION` model-command contract

### 1. API Entry
- Entry: `mcp__model-command__run`
- Command ID: `CONTINUE_SESSION`
- Auth/AuthZ: session-bound, same trust boundary as existing `ASK_USER_QUESTION` / `UPDATE_SESSION`

### 2. Input
- Request payload:
  ```json
  {
    "commandId": "CONTINUE_SESSION",
    "params": {
      "prompt": "new https://github.com/org/repo/pull/123",
      "resetSession": true,
      "dispatchText": "https://github.com/org/repo/pull/123",
      "forceWorkflow": "pr-review"
    }
  }
  ```
- Validation rules:
  - `prompt`: non-empty string
  - `resetSession`: boolean, optional, defaults false
  - `dispatchText`: optional string
  - `forceWorkflow`: optional `WorkflowType`
  - `forceWorkflow` present → `resetSession` must be `true`

### 3. Layer Flow

#### 3a. Model Command Validation
- `request.commandId` → validator branch `CONTINUE_SESSION`
- `params.forceWorkflow` → `WorkflowType` allowlist check
- Transformation:
  - `params.prompt` → `ContinueSessionParams.prompt`
  - `params.dispatchText` → `ContinueSessionParams.dispatchText`
  - `params.forceWorkflow` → `ContinueSessionParams.forceWorkflow`

#### 3b. Model Command Catalog / MCP Server
- `CONTINUE_SESSION` is listed by `listModelCommands(context)`
- `runModelCommand()` echoes validated params into typed payload
- Transformation:
  - `ContinueSessionParams.prompt` → `model_command_result.payload.continuation.prompt`
  - `ContinueSessionParams.forceWorkflow` → `payload.continuation.forceWorkflow`

#### 3c. Stream Executor Parse
- `parseModelCommandRunResponse(raw)` → `commandId === 'CONTINUE_SESSION'`
- Transformation:
  - `payload.continuation.prompt` → `Continuation.prompt`
  - `payload.continuation.dispatchText` → `Continuation.dispatchText`
  - `payload.continuation.forceWorkflow` → `Continuation.forceWorkflow`

### 4. Side Effects
- No DB writes
- No Slack UI directly emitted
- Runtime state updated only in current execute result (`ExecuteResult.continuation`)

### 5. Error Paths

| Condition | Error | Result |
|-----------|-------|--------|
| `prompt` missing/empty | `INVALID_ARGS` | MCP returns error, stream ignores continuation |
| unknown workflow string | `INVALID_ARGS` | MCP returns error with allowlist guidance |
| `forceWorkflow` with `resetSession=false` | `INVALID_ARGS` | host continuation rejected before execution |

### 6. Output
- Success payload:
  ```json
  {
    "type": "model_command_result",
    "commandId": "CONTINUE_SESSION",
    "ok": true,
    "payload": {
      "continuation": {
        "prompt": "new https://github.com/org/repo/pull/123",
        "resetSession": true,
        "dispatchText": "https://github.com/org/repo/pull/123",
        "forceWorkflow": "pr-review"
      }
    }
  }
  ```

### 7. Observability Hooks
- Log `commandId`, `resetSession`, `forceWorkflow`, `dispatchTextPreview`
- Warn on invalid args with command-specific schema guidance

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `validator accepts CONTINUE_SESSION with prompt and forceWorkflow` | Happy Path | Scenario 1, Section 2 |
| `validator rejects CONTINUE_SESSION without prompt` | Sad Path | Scenario 1, Section 5 |
| `validator rejects forceWorkflow when resetSession is false` | Sad Path | Scenario 1, Section 5 |
| `catalog lists CONTINUE_SESSION for normal session context` | Contract | Scenario 1, Section 3b |
| `stream executor parses CONTINUE_SESSION into Continuation` | Contract | Scenario 1, Section 3c |

---

## Scenario 2 — Host continuation executes reset + forced workflow handoff

### 1. API Entry
- Entry: `StreamExecutor.execute()` returns `ExecuteResult.continuation`
- Host loop: `SlackHandler.handleMessage()`

### 2. Input
- Continuation payload:
  ```json
  {
    "prompt": "new fix https://github.com/org/repo/pull/123",
    "resetSession": true,
    "dispatchText": "fix https://github.com/org/repo/pull/123",
    "forceWorkflow": "pr-fix-and-update"
  }
  ```

### 3. Layer Flow

#### 3a. Stream Executor
- `model_command_result.payload.continuation` → `ExecuteResult.continuation`
- Only one continuation survives at end of execute cycle

#### 3b. Slack Handler Continuation Loop
- `ExecuteResult.continuation.resetSession` → `claudeHandler.resetSessionContext(channel, threadTs)`
- `Continuation.forceWorkflow` present → `sessionInitializer.initialize(..., effectiveText, forceWorkflow)`-equivalent reset path
- Transformation:
  - `Continuation.prompt` → next `execute({ text })`
  - `Continuation.dispatchText` → next dispatch classification text
  - `Continuation.forceWorkflow` → session.workflow

#### 3c. Session Initializer
- `forceWorkflow` bypasses classifier
- Session links remain derived from `dispatchText` / existing session PR link
- Transformation:
  - `dispatchText PR URL` → `session.links.pr`
  - `forceWorkflow` → `transitionToMain(channel, threadTs, workflow, title)`

### 4. Side Effects
- Session context reset
- Workflow title/state replaced
- Thread panel re-renders for new workflow

### 5. Error Paths

| Condition | Error | Result |
|-----------|-------|--------|
| session missing after reset | host runtime error | abort current loop and report failure message |
| forced workflow invalid | validation should have blocked earlier | no continuation execution |
| dispatch text missing PR URL for PR workflow | links not updated | workflow still forced, prompt must carry URL explicitly |

### 6. Output
- Session now behaves as if user typed `new <prompt>` or `new fix <PR_URL>`
- Next stream turn runs under forced workflow prompt set

### 7. Observability Hooks
- Log `continuation applied`, `session reset`, `forced workflow`
- Thread panel phase: `워크플로우 전환 중`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `slack handler resets session and reapplies continuation prompt` | Happy Path | Scenario 2, Section 3b |
| `slack handler forces workflow when continuation includes forceWorkflow` | Contract | Scenario 2, Section 3c |
| `session initializer preserves PR link on forced workflow handoff` | Side-Effect | Scenario 2, Section 4 |
| `continuation without resetSession does not force workflow` | Sad Path | Scenario 2, Section 5 |

---

## Scenario 3 — `pr-review` waits on CI and routes failures into fix decisions

### 1. API Entry
- Entry: `pr-review` workflow prompt after review summary or after re-review handoff
- Data sources:
  - GitHub PR review metadata
  - GitHub checks / CI summary
  - current session PR link

### 2. Input
- Required inputs:
  - active PR URL
  - review summary / findings state
  - CI status snapshot
  - latest approver summary
- Validation rules:
  - poll interval fixed to 60 seconds
  - pending / queued / in_progress are non-terminal
  - terminal failure requires failure summary before user question

### 3. Layer Flow

#### 3a. PR Metadata Fetch
- `session.links.pr.url` → GitHub PR info
- `PR URL` → `check runs / combined status / mergeability`
- Transformation:
  - `PR URL` → `CiSummary.status`
  - `PR URL` → `ApproverSummary[]`

#### 3b. Prompt Reasoning
- If CI pending:
  - wait 60s
  - re-check status
- If CI failed:
  - summarize failing checks
  - estimate switching cost for fix
  - tiny/small → autonomous path
  - medium+ → `ASK_USER_QUESTION`
- If CI succeeded and mergeable:
  - continue to merge gate scenario

#### 3c. Failure-to-Fix Handoff
- user selects "fix in this PR" or model decides autonomous fix
- Transformation:
  - failing check summary → fix plan summary
  - fix plan summary + PR URL → `CONTINUE_SESSION(prompt="new fix <PR>", resetSession=true, forceWorkflow="pr-fix-and-update")`

### 4. Side Effects
- Slack thread receives CI wait / failure / retry updates
- Optional workflow handoff into `pr-fix-and-update`
- No merge executed in this scenario

### 5. Error Paths

| Condition | Error | Result |
|-----------|-------|--------|
| CI API unavailable | metadata fetch failure | report status unknown, stop before merge gate |
| CI never reaches terminal state within model turn budget | long-running poll | keep user informed and continue polling in-session |
| failure summary missing actionable detail | insufficient context | do not ask fix question without summarized failing checks |

### 6. Output
- Pending CI: progress update
- Failed CI: fix decision question or autonomous fix continuation
- Successful CI: merge gate question

### 7. Observability Hooks
- Log poll count, last CI state, failing check names
- Thread messages should include absolute status terms (`pending`, `failure`, `success`)

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `pr review prompt mentions 60 second CI polling loop` | Contract | Scenario 3, Section 2 |
| `ci failure path requests decision gate before fix handoff` | Contract | Scenario 3, Section 3b |
| `ci failure can emit CONTINUE_SESSION to pr-fix-and-update` | Happy Path | Scenario 3, Section 3c |
| `unknown ci state blocks merge gate` | Sad Path | Scenario 3, Section 5 |

---

## Scenario 4 — Merge gate question replaces direct merge shortcut

### 1. API Entry
- Entry: `pr-review` workflow after CI status == success and PR is mergeable
- Trigger source: model-generated `ASK_USER_QUESTION`

### 2. Input
- Merge gate context:
  - AS-IS
  - TO-BE
  - why this PR is needed
  - approver list + approval rationale
  - CI summary
  - PR mergeability
- Choice set:
  - `merge_now`
  - `rerun_review`
  - `wait_for_other_review`

### 3. Layer Flow

#### 3a. Prompt Assembly
- PR summary + approval summary + CI summary → merge gate narrative
- Transformation:
  - `ReviewSummary.asIs` → merge gate context block
  - `ReviewSummary.toBe` → merge gate context block
  - `ApproverSummary[]` → "누가 approve 했는지" section
  - `CiSummary` → status section

#### 3b. ASK_USER_QUESTION Rendering
- payload type: `user_choice`
- choice IDs remain compact, but option labels are self-contained

#### 3c. Post-Choice Behavior
- `merge_now` → current workflow continues and executes merge path
- `rerun_review` → model emits `CONTINUE_SESSION(prompt="new <PR_URL>", resetSession=true, forceWorkflow="pr-review")`
- `wait_for_other_review` → current workflow stops without merge

#### 3d. Action Panel Guard
- `pr-review` / `pr-fix-and-update` panels do not render `panel_pr_merge`
- merge remains available only through merge gate question outcome

### 4. Side Effects
- Merge button hidden from panel
- Merge execution happens only after model sees explicit user selection
- Thread records final merge decision context before merge

### 5. Error Paths

| Condition | Error | Result |
|-----------|-------|--------|
| PR approved but not mergeable | conflict/protection pending | no merge choice shown |
| approver summary unavailable | incomplete merge context | do not present merge gate as ready |
| direct merge action invoked from stale message | unsupported path | action handler rejects or button no longer rendered |

### 6. Output
- A single merge gate question with 3 choices
- No direct merge button for PR workflows

### 7. Observability Hooks
- Log `merge gate ready`, `merge gate blocked`, `merge gate choice`
- Record approver usernames and CI aggregate state in structured log fields

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `action panel hides merge button for pr-review workflow` | Side-Effect | Scenario 4, Section 3d |
| `action panel hides merge button for pr-fix-and-update workflow` | Side-Effect | Scenario 4, Section 3d |
| `pr review prompt requires as-is to-be approval and ci context before merge question` | Contract | Scenario 4, Section 2 |
| `rerun review choice emits CONTINUE_SESSION for pr-review` | Happy Path | Scenario 4, Section 3c |

---

## Scenario 5 — `pr-fix-and-update` auto-recurses into `pr-review`

### 1. API Entry
- Entry: `pr-fix-and-update` workflow after review feedback selection and code changes
- Trigger source: push completed successfully

### 2. Input
- Required inputs:
  - active PR URL
  - applied fix summary
  - verification result (`test`, `build`, optional extra checks)
- Validation rules:
  - local verification must complete before handoff
  - push must succeed before re-review handoff

### 3. Layer Flow

#### 3a. Fix Workflow Completion
- fix summary + push result → completion report
- Transformation:
  - `changed files` → completion summary
  - `verification output` → completion summary

#### 3b. Recursive Re-Review Handoff
- model emits:
  - `prompt = "new <PR_URL>"`
  - `resetSession = true`
  - `dispatchText = "<PR_URL>"`
  - `forceWorkflow = "pr-review"`
- host resets session and re-enters review

#### 3c. Re-Review-to-Re-Fix Bounce
- if re-review discovers new fix work:
  - merge gate is not shown
  - model emits `CONTINUE_SESSION(prompt="new fix <PR_URL>", resetSession=true, forceWorkflow="pr-fix-and-update")`

### 4. Side Effects
- Thread remains in same Slack thread
- Session context is reset between fix and review loops
- PR link remains active session resource

### 5. Error Paths

| Condition | Error | Result |
|-----------|-------|--------|
| push fails | git/network error | stop in fix workflow, no review handoff |
| verification fails | failing tests/build | no handoff until resolved |
| PR URL missing from session | invalid session state | ask user to relink PR before handoff |

### 6. Output
- Fix workflow ends with automatic review restart instead of passive "재리뷰 받으려면 새 세션..."
- Re-review can recursively return to fix workflow

### 7. Observability Hooks
- Log fix loop count, review loop count
- Thread message notes when auto re-review starts

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `pr fix prompt instructs automatic transition to pr-review after push` | Contract | Scenario 5, Section 3b |
| `re-review finding can emit CONTINUE_SESSION to pr-fix-and-update` | Happy Path | Scenario 5, Section 3c |
| `failed push blocks automatic review restart` | Sad Path | Scenario 5, Section 5 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| merge action 자체는 새 workflow로 분리하지 않고 현재 review session 안에서 수행한다 | small | 요구사항의 핵심은 merge gate 추가이며 별도 workflow 추가는 불필요한 복잡도다 |
| CI polling은 prompt-level orchestration으로 시작하고 background worker는 도입하지 않는다 | small | 현재 구조에서 가장 작은 변경으로 요구사항을 만족한다 |
| rerun review / fix recursion은 모두 `CONTINUE_SESSION + forceWorkflow`로 통일한다 | small | `/new`, `/renew`, prompt parsing, panel action 간 의미 차이를 host에서 하나의 continuation 경로로 수렴할 수 있다 |

## Trace Deviations

None.

## Implementation Status

| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. `CONTINUE_SESSION` model-command contract | done | GREEN | Complete |
| 2. Host continuation executes reset + forced workflow handoff | done | GREEN | Complete |
| 3. `pr-review` waits on CI and routes failures into fix decisions | done | GREEN | Complete |
| 4. Merge gate question replaces direct merge shortcut | done | GREEN | Complete |
| 5. `pr-fix-and-update` auto-recurses into `pr-review` | done | GREEN | Complete |

## Verified At

2026-03-10 — All 5 scenarios GREEN + Verified
