# Cron Scheduler System — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/cron-scheduler/spec.md

## Table of Contents
1. [Scenario 1 — SDK Cron Tool Blocking](#scenario-1)
2. [Scenario 2 — Cron MCP: cron_create](#scenario-2)
3. [Scenario 3 — Cron MCP: cron_delete & cron_list](#scenario-3)
4. [Scenario 4 — CronScheduler: Idle Session Injection](#scenario-4)
5. [Scenario 5 — CronScheduler: Busy Session Queue + Idle Drain](#scenario-5)
6. [Scenario 6 — CronScheduler: No Session → New Thread](#scenario-6)

---

## Scenario 1 — SDK Cron Tool Blocking

### 1. API Entry
- Entry: `McpConfigBuilder.buildConfig()` called during every Claude query
- Auth: N/A (internal build step)

### 2. Input
- `slackContext?: SlackContext` — present for all Slack messages

### 3. Layer Flow

#### 3a. McpConfigBuilder.buildConfig()
- File: `src/mcp-config-builder.ts:126-246`
- At line 27: `NATIVE_INTERACTIVE_TOOLS` constant
- Current: `['AskUserQuestion']`
- Change to: `['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList']`
- At line 236: `config.disallowedTools = [...NATIVE_INTERACTIVE_TOOLS]`
- Transformation: `NATIVE_INTERACTIVE_TOOLS` array → `config.disallowedTools` array

#### 3b. ClaudeHandler.queryStream()
- File: `src/claude-handler.ts:447-449`
- `mcpConfig.disallowedTools` → `options.disallowedTools`
- SDK receives disallowedTools and removes them from model's tool palette

### 4. Side Effects
- None (config-time only)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| No slackContext | disallowedTools not set | SDK cron tools available — acceptable (non-Slack context) |

### 6. Output
- `McpConfig.disallowedTools` includes `CronCreate`, `CronDelete`, `CronList`

### 7. Observability
- Logger: `McpConfigBuilder` debug log at line 223 already logs disallowedTools

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `blocks SDK cron tools when slackContext present` | Happy Path | S1, Section 3a |
| `does not block cron tools without slackContext` | Sad Path | S1, Section 5 |

---

## Scenario 2 — Cron MCP: cron_create

### 1. API Entry
- MCP Tool: `cron_create`
- Server: `mcp-servers/cron/cron-mcp-server.ts` (NEW)
- Auth: owner extracted from `SOMA_CRON_CONTEXT` env var

### 2. Input
```json
{
  "name": "string (required) - unique name per owner",
  "expression": "string (required) - 5-field cron expression (min hour dom mon dow)",
  "prompt": "string (required) - message to inject when cron fires",
  "channel": "string (required) - Slack channel ID",
  "threadTs": "string (optional) - target thread, null for new thread"
}
```
- Validation:
  - `name`: non-empty, alphanumeric + hyphens, max 64 chars
  - `expression`: valid 5-field cron (parsed by cron-expression-parser)
  - `prompt`: non-empty, max 4000 chars
  - `channel`: starts with 'C' or 'D'

### 3. Layer Flow

#### 3a. MCP Handler (cron-mcp-server.ts)
- Pattern: `mcp-servers/model-command/model-command-mcp-server.ts:173-200`
- `CallToolRequestSchema` handler routes to `handleCreate()`
- Transformation: `request.params.arguments` → `{ name, expression, prompt, channel, threadTs }`
- `owner` derived from `SOMA_CRON_CONTEXT.user`
- `id` generated: `crypto.randomUUID()`
- `createdAt`: `new Date().toISOString()`

#### 3b. CronStorage (cron-storage.ts — NEW)
- File: `src/cron-storage.ts`
- Pattern: `src/metrics/report-scheduler.ts:172-195` (loadScheduleState/saveScheduleState)
- `CronStorage.addJob(job: CronJob): void`
- Reads `cron-jobs.json` → appends job → atomic write (tmp + rename)
- Transformation: `CronJob` → JSON serialization → `${DATA_DIR}/cron-jobs.json`

#### 3c. Storage (JSON file)
- File: `${DATA_DIR}/cron-jobs.json`
- Mapping: `CronJob.id → jobs[].id`, `CronJob.name → jobs[].name`, etc.
- Constraint: UNIQUE(owner, name) — enforced in addJob()

### 4. Side Effects
- FILE WRITE: `${DATA_DIR}/cron-jobs.json` — append job to jobs array

### 5. Error Paths
| Condition | Error | Response |
|-----------|-------|----------|
| Duplicate name for same owner | DUPLICATE_NAME | `{ isError: true, content: "Cron job '{name}' already exists" }` |
| Invalid cron expression | INVALID_EXPRESSION | `{ isError: true, content: "Invalid cron expression: {details}" }` |
| Empty name/prompt | VALIDATION_ERROR | `{ isError: true, content: "name and prompt are required" }` |

### 6. Output
```json
{
  "content": [{ "type": "text", "text": "Cron job 'daily-standup' created. Expression: 0 9 * * 1-5" }]
}
```

### 7. Observability
- Logger: `CronMcpServer` info on create

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `cron_create stores job with correct fields` | Happy Path | S2, Section 3 |
| `cron_create rejects duplicate name for same owner` | Sad Path | S2, Section 5 |
| `cron_create rejects invalid cron expression` | Sad Path | S2, Section 5 |
| `cron_create persists to JSON file` | Side-Effect | S2, Section 4 |
| `request.name → CronJob.name → jobs[].name` | Contract | S2, Section 3 |

---

## Scenario 3 — Cron MCP: cron_delete & cron_list

### 1. API Entry
- MCP Tools: `cron_delete`, `cron_list`
- Server: `mcp-servers/cron/cron-mcp-server.ts`

### 2. Input
- `cron_delete`: `{ "name": "string (required)" }`
- `cron_list`: (no params)

### 3. Layer Flow

#### 3a. cron_delete
- `CallToolRequestSchema` handler → `handleDelete()`
- Reads `owner` from `SOMA_CRON_CONTEXT.user`
- `CronStorage.removeJob(owner, name)` — filters out matching job, atomic write
- Returns removed count (0 or 1)

#### 3b. cron_list
- `CallToolRequestSchema` handler → `handleList()`
- Reads `owner` from `SOMA_CRON_CONTEXT.user`
- `CronStorage.getJobsByOwner(owner)` — filters jobs by owner
- Returns formatted list

### 4. Side Effects
- `cron_delete`: FILE WRITE — remove job from `cron-jobs.json`
- `cron_list`: None (read-only)

### 5. Error Paths
| Condition | Error | Response |
|-----------|-------|----------|
| Delete non-existent job | NOT_FOUND | `{ isError: true, content: "Cron job '{name}' not found" }` |

### 6. Output
- `cron_delete`: `"Cron job 'daily-standup' deleted"`
- `cron_list`: Formatted table of jobs with name, expression, channel, last run

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `cron_delete removes existing job` | Happy Path | S3, Section 3a |
| `cron_delete returns error for non-existent job` | Sad Path | S3, Section 5 |
| `cron_list returns only owner's jobs` | Happy Path | S3, Section 3b |
| `cron_list returns empty for no jobs` | Sad Path | S3, Section 3b |
| `owner isolation: cannot delete other user's cron` | Contract | S3, Section 3a |

---

## Scenario 4 — CronScheduler: Idle Session Injection

### 1. API Entry
- Internal: `CronScheduler.tick()` called every 60s by setInterval
- Pattern: `src/metrics/report-scheduler.ts:95-105`

### 2. Input
- Current time (UTC)
- All registered cron jobs from `CronStorage.getAll()`

### 3. Layer Flow

#### 3a. CronScheduler.tick()
- File: `src/cron-scheduler.ts` (NEW)
- For each job: evaluate `matchesCronExpression(expression, now)` → boolean
- Dedup: `job.lastRunDate !== todayStr` (pattern from `report-scheduler.ts:127`)
- If due: lookup session via `sessionRegistry.getAllSessions()` → find by `job.owner` + `job.channel`

#### 3b. Session Lookup + Idle Check
- `sessionRegistry.getAllSessions()` (line 197) → iterate Map
- Match: `session.ownerId === job.owner && session.channelId === job.channel && session.isActive`
- Check: `session.activityState === 'idle'`
- If idle → proceed to injection

#### 3c. Synthetic Message Injection
- Pattern: `src/slack-handler.ts:745-762` (autoResumeSession)
- Build synthetic event:
  ```typescript
  const syntheticEvent: MessageEvent = {
    user: job.owner,
    channel: session.channelId,
    thread_ts: session.threadTs,
    ts: `${Date.now() / 1000}`,
    text: `[cron:${job.name}] ${job.prompt}`,
  };
  ```
- Call: `this.messageInjector(syntheticEvent, noopSay)`
- Transformation: `CronJob.prompt → syntheticEvent.text → handleMessage pipeline`

#### 3d. Update lastRunDate
- `CronStorage.updateLastRun(job.id, now)` — atomic write

### 4. Side Effects
- FILE WRITE: `cron-jobs.json` — update `lastRunAt` and `lastRunDate`
- MESSAGE: synthetic event injected into Slack handleMessage pipeline

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| matchesCronExpression throws | Log warning | Skip this job, continue to next |
| handleMessage throws | Log error | Job marked as run to prevent retry storm |
| Session terminated mid-check | No injection | Skip gracefully |

### 6. Output
- Cron prompt appears in session thread as if user sent it
- Model processes the prompt normally

### 7. Observability
- Logger: `CronScheduler` info on each fired cron with job name, session key, channel

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `fires cron when session is idle and expression matches` | Happy Path | S4, Section 3 |
| `does not fire when expression does not match current time` | Sad Path | S4, Section 3a |
| `does not fire same job twice on same date` | Contract | S4, Section 3a (dedup) |
| `updates lastRunDate after successful injection` | Side-Effect | S4, Section 4 |
| `injects synthetic message with cron prompt as text` | Contract | S4, Section 3c |

---

## Scenario 5 — CronScheduler: Busy Session Queue + Idle Drain

### 1. API Entry
- Internal: `CronScheduler.tick()` when session.activityState !== 'idle'
- Internal: `SessionRegistry.setActivityState(idle)` draining queued crons

### 2. Input
- Due cron job + session with `activityState === 'working'` or `'waiting'`

### 3. Layer Flow

#### 3a. CronScheduler.tick() — Enqueue
- Session found but `activityState !== 'idle'`
- `this.pendingCronQueue.get(sessionKey)` → append job
- `this.sessionRegistry.registerOnIdle(sessionKey, callback)`
- Callback: `() => this.drainQueue(sessionKey)`

#### 3b. SessionRegistry.setActivityState() — onIdle hook
- File: `src/session-registry.ts:369-387`
- After existing logic (line 384-386: save on idle):
  ```typescript
  // NEW: drain onIdle callbacks
  if (state === 'idle') {
    const sessionKey = this.getSessionKey(channelId, threadTs);
    this.drainOnIdleCallbacks(sessionKey);
  }
  ```
- Also in `setActivityStateByKey()` (line 392-403)

#### 3c. SessionRegistry — onIdle callback registry
- NEW private field: `private onIdleCallbacks: Map<string, Array<() => void>> = new Map()`
- `registerOnIdle(sessionKey, callback)` — appends to array
- `drainOnIdleCallbacks(sessionKey)` — calls all, deletes key
- Fire-and-forget: callbacks wrapped in try/catch

#### 3d. CronScheduler.drainQueue() — Deferred injection
- Pops first job from `pendingCronQueue.get(sessionKey)`
- Injects via synthetic message (same as Scenario 4, Section 3c)
- If more jobs remain → re-register onIdle for next idle cycle
- One job per idle transition (prevents flooding)

### 4. Side Effects
- Same as Scenario 4 (message injection + lastRunDate update)
- But deferred to idle transition

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Session terminated before idle | Queue orphaned | Clean up on session removal |
| Callback throws | Log error, continue | Other callbacks still fire |
| Multiple crons queued | Drain one per idle | Remaining re-queued for next idle |

### 6. Output
- Same as Scenario 4, but delayed until model finishes current turn

### 7. Observability
- Logger: `CronScheduler` info "queued cron {name} for session {key}, waiting for idle"
- Logger: `SessionRegistry` debug "draining N onIdle callbacks for {sessionKey}"

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `queues cron when session is busy` | Happy Path | S5, Section 3a |
| `drains queue on idle transition` | Happy Path | S5, Section 3b-3d |
| `drains one job per idle transition` | Contract | S5, Section 3d |
| `registerOnIdle callback fires on setActivityState idle` | Contract | S5, Section 3b |
| `orphaned queue cleaned on session removal` | Side-Effect | S5, Section 5 |

---

## Scenario 6 — CronScheduler: No Session → New Thread

### 1. API Entry
- Internal: `CronScheduler.tick()` when no active session found for job owner+channel

### 2. Input
- Due cron job + no matching session in SessionRegistry

### 3. Layer Flow

#### 3a. CronScheduler.tick() — No session branch
- `sessionRegistry.getAllSessions()` → no match for `job.owner + job.channel`
- Need to create a new bot-initiated thread

#### 3b. Bot-Initiated Thread Creation
- Use `SlackApiHelper.postMessage()` to create root message in channel
- Root message text: `[cron:${job.name}] Scheduled task`
- Capture `rootTs` from response
- Build synthetic event with `thread_ts: rootTs`

#### 3c. Inject into New Thread
- Same synthetic message pattern as Scenario 4, Section 3c
- `thread_ts` = new root message ts
- `handleMessage` creates a new session automatically (SessionInitializer)

### 4. Side Effects
- SLACK MESSAGE: New root message in channel (bot-initiated)
- FILE WRITE: `cron-jobs.json` — update lastRunDate

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| postMessage fails | Log error | Skip this run, retry next cycle |
| Channel not accessible | Slack API error | Log and skip |

### 6. Output
- New thread created in channel with cron prompt

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `creates new thread when no session exists` | Happy Path | S6, Section 3 |
| `skips gracefully on Slack API failure` | Sad Path | S6, Section 5 |
| `new thread receives cron prompt as first message` | Contract | S6, Section 3c |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Cron expression matching: simple minute/hour/dom/month/dow comparison | small (~15 lines) | No external dep needed for basic matching |
| One-job-per-idle-drain to prevent flooding | small (~5 lines) | Prevents model overload |
| `[cron:{name}]` prefix on injected messages | tiny (~1 line) | Model can identify cron-triggered messages |
| Queue cleanup on session removal | small (~10 lines) | Prevents memory leak |

## Implementation Status
| # | Scenario | Size | Trace | Tests (RED) | Status |
|---|----------|------|-------|-------------|--------|
| 1 | SDK Cron Tool Blocking | tiny | done | RED | Ready |
| 2 | Cron MCP: cron_create | medium | done | RED | Ready |
| 3 | Cron MCP: cron_delete & cron_list | small | done | RED | Ready |
| 4 | CronScheduler: Idle Injection | medium | done | RED | Ready |
| 5 | CronScheduler: Busy Queue + Idle Drain | large | done | RED | Ready |
| 6 | CronScheduler: No Session → New Thread | medium | done | RED | Ready |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work`
