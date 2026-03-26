# Deploy Notification Channel Splitting — Vertical Trace

> STV Trace | Created: 2026-03-26
> Spec: docs/deploy-channel-split/spec.md

## Table of Contents
1. [Scenario 1 — Deploy Workflow Dispatch](#scenario-1--deploy-workflow-dispatch)
2. [Scenario 2 — Deploy Output Routing to Log Channel](#scenario-2--deploy-output-routing-to-log-channel)
3. [Scenario 3 — Deploy Success Summary](#scenario-3--deploy-success-summary)
4. [Scenario 4 — Deploy Failure Summary with Error Details](#scenario-4--deploy-failure-summary-with-error-details)
5. [Scenario 5 — Log Channel Fallback](#scenario-5--log-channel-fallback)

---

## Scenario 1 — Deploy Workflow Dispatch

### 1. Event Entry
- Trigger: Slack message containing deploy-related patterns (e.g., `repo source -> target`, `deploy`, `배포`)
- Entry: `EventRouter → SlackHandler.handleMessage() → SessionInitializer.initialize()`
- Auth: Slack user with bot mention access

### 2. Input
- User message text containing deploy keywords
- Channel ID, Thread TS, User ID from Slack event

### 3. Layer Flow

#### 3a. DispatchService (src/dispatch-service.ts)
- `dispatch(userMessage)` classifies user intent
- Transformation: `userMessage.text` → `DispatchResult.workflow = 'deploy'`
- Pattern match: message contains deploy-related keywords → returns `{ workflow: 'deploy', title: '...' }`
- `validateWorkflow()` accepts 'deploy' as valid workflow type

#### 3b. SessionInitializer (src/slack/pipeline/session-initializer.ts)
- `initialize()` calls `claudeHandler.transitionToMain(channel, threadTs, 'deploy', title)`
- Transformation: `DispatchResult.workflow` → `session.workflow = 'deploy'`

#### 3c. PromptBuilder (src/prompt-builder.ts)
- `loadWorkflowPrompt('deploy')` loads `src/prompt/workflows/deploy.prompt`
- `buildSystemPrompt(userId, 'deploy')` returns deploy-specific system prompt + persona

### 4. Side Effects
- Session state: `session.workflow = 'deploy'` stored in SessionRegistry
- Workflow prompt cache: deploy.prompt cached in `workflowPromptCache`

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Dispatch model fails | API error | Falls back to `workflow: 'default'` |
| deploy.prompt not found | File missing | Falls back to default system prompt |

### 6. Output
- DispatchResult: `{ workflow: 'deploy', title: 'Deploy ...' }`
- Session: `session.workflow = 'deploy'`

### 7. Observability
- Logger: `DispatchService.dispatch` logs workflow result
- Logger: `PromptBuilder.loadWorkflowPrompt` logs prompt load

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `dispatch_deploy_pattern_happy_path` | Happy Path | Scenario 1, Section 3a |
| `dispatch_deploy_validates_workflow_type` | Contract | Scenario 1, Section 3a, validateWorkflow |
| `dispatch_deploy_fallback_on_failure` | Sad Path | Scenario 1, Section 5 |

---

## Scenario 2 — Deploy Output Routing to Log Channel

### 1. Event Entry
- Trigger: StreamExecutor.execute() with `session.workflow === 'deploy'`
- Entry: `StreamExecutor.execute()` → stream context creation
- Prerequisite: `DEPLOY_LOG_CHANNEL` env var set, session dispatched as 'deploy'

### 2. Input
- `StreamExecuteParams.session.workflow === 'deploy'`
- `config.deploy.logChannel` — target channel ID for detailed logs
- `StreamExecuteParams.channel` — original channel (for summary)
- `StreamExecuteParams.threadTs` — original thread

### 3. Layer Flow

#### 3a. StreamExecutor (src/slack/pipeline/stream-executor.ts)
- At `execute()` start, checks `session.workflow === 'deploy' && config.deploy.logChannel`
- Creates `logSay` function:
  - Transformation: `msg` → `slackApi.postMessage(config.deploy.logChannel, msg.text, { threadTs: logThreadTs })`
  - First call creates a root message in log channel, captures `logThreadTs`
  - Subsequent calls thread under `logThreadTs`
- Creates `originalSay` = original say function (preserved for summary)
- Overrides `streamContext.say` → `logSay`

#### 3b. StreamProcessor (src/slack/stream-processor.ts)
- No changes. Receives wrapped `say` via `StreamContext`
- All `handleTextMessage`, `handleToolUseMessage` calls use `context.say` → routes to log channel
- `handleResultMessage` uses `context.say` → also routes to log channel (result text)

#### 3c. StreamExecutor completion handler
- After `processor.process()` completes:
  - Extracts result content from stream
  - Calls `DeploySummaryFormatter.format()` to build summary
  - Posts summary to original channel via `originalSay`

### 4. Side Effects
- Slack messages: intermediate output posted to `DEPLOY_LOG_CHANNEL` (new thread)
- Slack messages: summary posted to original channel/thread
- Status message + reaction: still managed on original channel (unchanged)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| DEPLOY_LOG_CHANNEL not set | Config missing | Use original say (no routing, existing behavior) |
| Log channel post fails | Slack API error | Fall back to original say, log warning |
| Log channel not accessible | Permission error | Fall back to original say, log warning |

### 6. Output
- Log channel: receives all intermediate messages (tool use, text, tool results)
- Original channel: receives only the final summary

### 7. Observability
- Logger: `StreamExecutor` logs deploy routing activation
- Logger: `StreamExecutor` logs log channel post failures

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `deploy_routes_output_to_log_channel` | Happy Path | Scenario 2, Section 3a-3b |
| `deploy_preserves_original_channel_for_summary` | Contract | Scenario 2, Section 3c |
| `deploy_non_deploy_workflow_unchanged` | Contract | Scenario 2, Section 3a, guard clause |
| `deploy_log_channel_not_set_fallback` | Sad Path | Scenario 2, Section 5, row 1 |
| `deploy_log_channel_post_failure_fallback` | Sad Path | Scenario 2, Section 5, row 2 |

---

## Scenario 3 — Deploy Success Summary

### 1. Event Entry
- Trigger: StreamExecutor completion handler (stream result success, no errors)
- Entry: after `processor.process()` returns `{ success: true }`

### 2. Input
- Stream result text (Claude's final output)
- Expected format from deploy.prompt: structured summary data (env, version, build/deploy/e2e status)

### 3. Layer Flow

#### 3a. StreamExecutor completion (src/slack/pipeline/stream-executor.ts)
- Detects `streamResult.success && !streamResult.aborted && session.workflow === 'deploy'`
- Passes result text to `DeploySummaryFormatter.format(resultText)`

#### 3b. DeploySummaryFormatter (src/slack/deploy-summary-formatter.ts)
- `format(resultText)`: parses Claude's final output for deploy metadata
- Transformation: `resultText` → `DeploySummary { env, version, build, deploy, e2e, allSuccess }`
- `formatSuccessLine(summary)`: generates one-line summary
  - Output: `[{env}] {version} | build: ok | deploy: ok | e2e: ok`
- Returns: `{ text: summaryLine, attachments: undefined }`

#### 3c. Post to original channel
- `originalSay({ text: summaryLine, thread_ts: threadTs })`
- Single message, no attachments, no blocks

### 4. Side Effects
- Slack message: one-line summary posted to original channel/thread

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Result text unparseable | Format mismatch | Post raw result text to original channel (graceful) |
| Summary generation fails | Exception | Post generic "Deploy completed" message |

### 6. Output
- Original channel message: `[Dev2] 0.1.0-d198882 | build: ok | deploy: ok | e2e: ok`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `summary_format_success_one_line` | Happy Path | Scenario 3, Section 3b |
| `summary_format_all_statuses` | Contract | Scenario 3, Section 3b, formatSuccessLine |
| `summary_unparseable_result_fallback` | Sad Path | Scenario 3, Section 5, row 1 |

---

## Scenario 4 — Deploy Failure Summary with Error Details

### 1. Event Entry
- Trigger: StreamExecutor completion handler (stream result with failure indicators)
- OR: StreamExecutor error handler (stream processing error)

### 2. Input
- Stream result text containing failure indicators (Claude detects deploy/build/e2e failure)
- Failure metadata: environment, platform, namespace, images, duration, conclusion, run URL

### 3. Layer Flow

#### 3a. StreamExecutor completion (src/slack/pipeline/stream-executor.ts)
- Same entry as Scenario 3
- Passes result to `DeploySummaryFormatter.format(resultText)`
- Formatter detects failure → returns summary + error attachment

#### 3b. DeploySummaryFormatter (src/slack/deploy-summary-formatter.ts)
- `format(resultText)`: parses and detects failure in any stage
- `formatFailureLine(summary)`: generates one-line summary with fail indicator
  - Output: `[{env}] {version} | build: ok | deploy: fail`
- `buildErrorAttachment(summary)`: builds Slack red attachment block
  - Transformation: `DeploySummary` → Slack attachment with `color: 'danger'`
  - Fields: Environment, Platform, Namespace, Images, Duration, Conclusion, Run URL, Error
  - Format: Slack mrkdwn bold (`*field:*`) for labels
- Returns: `{ text: failureLine, attachments: [errorAttachment] }`

#### 3c. Post to original channel
- `originalSay({ text: failureLine, thread_ts: threadTs, attachments: [errorAttachment] })`
- Single message with red attachment block

### 4. Side Effects
- Slack message: summary line + red error attachment posted to original channel/thread

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Error metadata missing | Partial data | Show available fields, omit missing ones |
| Attachment build fails | Exception | Post text-only error summary |

### 6. Output
```
[Dev2] 0.1.0-d198882 | build: ok | deploy: fail

(Slack danger attachment):
[Dev2] 0.1.0-b517504 deploy failed.
*Environment:* Dev2
*Platform:* linux/amd64
*Namespace:* ghcr.io/insightquest-io/gucci
*Images:* 9
*Duration:* 9s
*Conclusion:* failure
Run: <https://github.com/.../runs/123|#338>
*Error:* see thread for full logs.
```

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `summary_format_failure_with_attachment` | Happy Path | Scenario 4, Section 3b |
| `summary_error_attachment_red_color` | Contract | Scenario 4, Section 3b, buildErrorAttachment |
| `summary_error_attachment_fields` | Contract | Scenario 4, Section 3b, field mapping |
| `summary_partial_metadata_graceful` | Sad Path | Scenario 4, Section 5, row 1 |

---

## Scenario 5 — Log Channel Fallback

### 1. Event Entry
- Trigger: StreamExecutor.execute() with `session.workflow === 'deploy'` but log channel unavailable

### 2. Input
- `config.deploy.logChannel` is empty/undefined OR Slack API returns error for log channel

### 3. Layer Flow

#### 3a. StreamExecutor (src/slack/pipeline/stream-executor.ts)
- Guard: `if (!config.deploy.logChannel)` → skip routing, use original say
- OR: `logSay` first call throws → catch, log warning, swap to original say for remaining messages

#### 3b. StreamProcessor
- Receives original `say` (no routing) → all output goes to original channel as before

### 4. Side Effects
- No log channel messages (fallback to original behavior)
- Warning logged

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Channel not configured | No env var | Existing behavior, no error |
| First post to log channel fails | Slack error | Switch to original say, log warning |

### 6. Output
- All output goes to original channel (identical to current behavior)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `deploy_no_log_channel_uses_original` | Happy Path | Scenario 5, Section 3a, guard |
| `deploy_log_channel_error_switches_to_original` | Sad Path | Scenario 5, Section 3a, catch |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| logSay creates root message then threads | tiny | Slack API threading pattern - standard |
| Status message stays on original channel | small | Status/reaction is per-session UX, not per-deploy-log |
| DeploySummary parsed from Claude final output text | small | Claude deploy.prompt structures the output, formatter parses it |
| Fallback posts raw text on parse failure | tiny | Graceful degradation - never lose output |
| test file location: src/slack/deploy-summary-formatter.test.ts | tiny | Follows existing pattern (*.test.ts next to source) |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Deploy Workflow Dispatch | done | RED | Ready for stv:work |
| 2. Deploy Output Routing to Log Channel | done | RED | Ready for stv:work |
| 3. Deploy Success Summary | done | RED | Ready for stv:work |
| 4. Deploy Failure Summary with Error Details | done | RED | Ready for stv:work |
| 5. Log Channel Fallback | done | RED | Ready for stv:work |

## Next Step
→ Proceed with implementation + Trace Verify via `stv:work`
