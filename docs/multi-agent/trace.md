# Multi-Agent Architecture — Vertical Trace

> STV Trace | Created: 2026-03-30
> Spec: docs/multi-agent/spec.md

## Table of Contents
1. [Scenario 1 — Agent Config Parsing](#scenario-1--agent-config-parsing)
2. [Scenario 2 — Agent Startup Lifecycle](#scenario-2--agent-startup-lifecycle)
3. [Scenario 3 — User Direct Chat with Sub-Agent](#scenario-3--user-direct-chat-with-sub-agent)
4. [Scenario 4 — agent_chat MCP Tool](#scenario-4--agent_chat-mcp-tool)
5. [Scenario 5 — agent_reply MCP Tool](#scenario-5--agent_reply-mcp-tool)
6. [Scenario 6 — Agent Prompt Loading](#scenario-6--agent-prompt-loading)
7. [Scenario 7 — Agent Graceful Shutdown](#scenario-7--agent-graceful-shutdown)

---

## Scenario 1 — Agent Config Parsing

> Size: small (~20 lines)

### 1. Entry Point
- Source: `loadUnifiedConfig()` in `src/unified-config-loader.ts`
- Trigger: Application startup (`src/index.ts`)

### 2. Input
- Config file: `config.json`
- `agents` section schema:
  ```json
  {
    "agents": {
      "{agentName}": {
        "slackBotToken": "xoxb-...",
        "slackAppToken": "xapp-...",
        "signingSecret": "...",
        "promptDir": "src/prompt/{agentName}",
        "persona": "default",
        "description": "...",
        "model": "claude-sonnet-4-20250514"
      }
    }
  }
  ```
- Validation rules:
  - `slackBotToken`: required, must start with `xoxb-`
  - `slackAppToken`: required, must start with `xapp-`
  - `signingSecret`: required, string, length >= 20
  - `promptDir`: optional, defaults to `src/prompt/{agentName}`
  - `persona`: optional, defaults to `"default"`
  - `description`: optional
  - `model`: optional, inherits from main bot

### 3. Layer Flow

#### 3a. Config Loader (`src/unified-config-loader.ts`)
- Reads raw JSON: `JSON.parse(fs.readFileSync(configFile, 'utf-8'))`
- Extracts agents section: `raw.agents` → validates each agent entry
- Transformation:
  - `raw.agents.{name}.slackBotToken` → `AgentConfig.slackBotToken`
  - `raw.agents.{name}.slackAppToken` → `AgentConfig.slackAppToken`
  - `raw.agents.{name}.signingSecret` → `AgentConfig.signingSecret`
  - `raw.agents.{name}.promptDir` → `AgentConfig.promptDir` (default: `src/prompt/{name}`)
  - `raw.agents.{name}.persona` → `AgentConfig.persona` (default: `"default"`)
  - `raw.agents.{name}.model` → `AgentConfig.model` (default: `undefined` → inherit)
- Returns: `UnifiedConfig.agents: Record<string, AgentConfig>`

#### 3b. Index (`src/index.ts`)
- Receives `unifiedConfig.agents`
- Passes to `AgentManager` constructor: `new AgentManager(agents, mcpManager)`

### 4. Side Effects
- None (pure parsing, no state mutation beyond in-memory config)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| `agents` section missing | No error | AgentManager created with empty map |
| Agent missing `slackBotToken` | Validation error | Log warning, skip this agent |
| Agent missing `slackAppToken` | Validation error | Log warning, skip this agent |
| Agent token format invalid | Validation error | Log warning, skip this agent |
| JSON parse error | Config load error | Falls back to legacy config (no agents) |

### 6. Output
- `UnifiedConfig` with populated `agents?: Record<string, AgentConfig>`
- Each valid agent config is a complete `AgentConfig` object

### 7. Observability
- Log: `Loaded {N} agent configurations: [{agent names}]`
- Log per skipped agent: `Skipping agent '{name}': {reason}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `AgentConfig_Parse_HappyPath` | Happy Path | S1, Section 3a |
| `AgentConfig_Parse_MissingSection` | Sad Path | S1, Section 5, Row 1 |
| `AgentConfig_Parse_InvalidToken` | Sad Path | S1, Section 5, Row 4 |
| `AgentConfig_Parse_DefaultValues` | Contract | S1, Section 3a, promptDir/persona defaults |

---

## Scenario 2 — Agent Startup Lifecycle

> Size: medium (~50 lines)

### 1. Entry Point
- Source: `AgentManager.startAll()` in `src/agent-manager.ts`
- Trigger: `index.ts` after config loaded, before `app.start()`

### 2. Input
- `agents: Record<string, AgentConfig>` from parsed config
- `mcpManager: McpManager` (shared instance)

### 3. Layer Flow

#### 3a. AgentManager (`src/agent-manager.ts`)
- Iterates `Object.entries(agents)`
- For each agent: creates `AgentInstance`
- Transformation:
  - `AgentConfig.slackBotToken` → `new App({ token: ... })`
  - `AgentConfig.slackAppToken` → `App({ appToken: ... })`
  - `AgentConfig.signingSecret` → `App({ signingSecret: ... })`
  - `AgentConfig.promptDir` → `PromptBuilder(agentPromptDir)`
  - `AgentConfig` → `AgentInstance` stored in `Map<string, AgentInstance>`

#### 3b. AgentInstance (`src/agent-instance.ts`)
- Creates Slack `App` (Bolt) instance with agent's tokens
- Creates dedicated `ClaudeHandler(mcpManager)` with agent-scoped `PromptBuilder`
- Creates dedicated `SlackHandler` wired to this App + ClaudeHandler
- Calls `slackHandler.setupEventHandlers()` for this agent's App
- Calls `app.start()` to establish Socket Mode connection

#### 3c. Event Handler Setup
- Same event handlers as main bot (message, app_mention)
- But scoped to agent's own App instance
- Uses agent's own `PromptBuilder` (loads from `promptDir`)

### 4. Side Effects
- N new Socket Mode WebSocket connections established
- N new Slack `App` instances in memory
- Agent instances registered in `AgentManager.agents` Map

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Invalid bot token | Slack API auth.test fails | Log error, skip this agent, continue others |
| Socket Mode connection fails | App.start() throws | Log error, skip agent, continue others |
| All agents fail | No fatal error | Main bot continues, AgentManager has 0 active agents |

### 6. Output
- `AgentManager` with `Map<string, AgentInstance>` of running agents
- Each agent responds to Slack events independently

### 7. Observability
- Log per agent: `Agent '{name}' started (bot_id: {id})`
- Log on failure: `Agent '{name}' failed to start: {error}`
- Log summary: `AgentManager: {N}/{total} agents started successfully`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `AgentStartup_HappyPath` | Happy Path | S2, Section 3b |
| `AgentStartup_InvalidToken_Skips` | Sad Path | S2, Section 5, Row 1 |
| `AgentStartup_PartialFailure_ContinuesOthers` | Sad Path | S2, Section 5, Row 2 |
| `AgentStartup_ZeroAgents_NoError` | Sad Path | S2, Section 5, Row 3 |

---

## Scenario 3 — User Direct Chat with Sub-Agent

> Size: small (~20 lines) — reuses existing SlackHandler/ClaudeHandler

### 1. Entry Point
- Source: Slack `app_mention` or `message` event on agent's App instance
- Trigger: User sends @장비 or DM to 장비 bot

### 2. Input
- Slack event payload:
  ```json
  {
    "type": "app_mention",
    "user": "U12345",
    "text": "<@AGENT_BOT_ID> 이 PR 리뷰해줘",
    "channel": "C12345",
    "ts": "1234567890.123456",
    "thread_ts": "1234567890.000000"
  }
  ```

### 3. Layer Flow

#### 3a. SlackHandler (agent's instance)
- Identical flow to main bot `handleMessage()`
- Event → validation → InputProcessor → SessionInitializer → StreamExecutor
- Transformation:
  - `event.text` → `prompt` (strip bot mention)
  - `event.user` → `ownerId`
  - `event.channel + thread_ts` → session key

#### 3b. ClaudeHandler (agent's instance)
- `streamQuery(prompt, session)` — same as main bot
- Key difference: `PromptBuilder` loads from agent's `promptDir`
- System prompt = agent-specific `default.prompt` + `common.prompt` fallback

#### 3c. Response
- Same response pipeline: markdown → Slack blocks → `say()`

### 4. Side Effects
- Session created in agent's `SessionRegistry`
- Message posted to Slack channel/thread via agent's bot token

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Agent prompt dir missing | PromptBuilder falls back to main prompts | Log warning |
| Claude query fails | Error response to user | Same error handling as main bot |

### 6. Output
- Slack message from agent bot in thread
- Session stored in agent's registry

### 7. Observability
- Same logging as main bot, prefixed with agent name

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `AgentDirectChat_UsesAgentPrompt` | Contract | S3, Section 3b, PromptBuilder loads agent dir |
| `AgentDirectChat_SessionIsolation` | Contract | S3, Section 4, agent's own SessionRegistry |

---

## Scenario 4 — agent_chat MCP Tool

> Size: medium (~50 lines)

### 1. Entry Point
- Source: MCP tool call `mcp__agent__chat`
- Trigger: Main bot's Claude query invokes `agent_chat` tool

### 2. Input
- MCP tool arguments:
  ```json
  {
    "agent": "jangbi",
    "prompt": "이 코드 리뷰해줘: ...",
    "config": {}
  }
  ```
- Validation:
  - `agent`: required, must match a registered agent name
  - `prompt`: required, non-empty string
  - `config`: optional overrides

### 3. Layer Flow

#### 3a. AgentMCPServer (`mcp-servers/agent/agent-mcp-server.ts`)
- Receives tool call from Claude SDK
- Validates `agent` name exists
- Transformation:
  - `args.agent` → agent name lookup
  - `args.prompt` → query prompt

#### 3b. AgentManager Query
- `AgentMCPServer` communicates with `AgentManager` via environment variable or IPC
- **Implementation detail**: AgentMCPServer runs as a child process (like all MCP servers). Communication with AgentManager uses a lightweight mechanism:
  - Option: AgentMCPServer creates its own `ClaudeHandler` with the target agent's prompt
  - The agent's config (promptDir, persona, model) is passed via `SOMA_AGENT_CONFIG` env var
  - Transformation:
    - `agentName` → `agentConfig` (from env)
    - `agentConfig.promptDir` → `PromptBuilder` initialization
    - `prompt` → `ClaudeHandler.streamQuery(prompt)`

#### 3c. Claude SDK Query
- `query({ prompt, options })` with agent's system prompt
- MCP servers: same as main bot (shared config)
- Session managed in AgentMCPServer's in-memory Map (like LLM server)
- Transformation:
  - `prompt` → Claude SDK query
  - Claude response → `{ sessionId, content, agentName, model }`

### 4. Side Effects
- Session stored in AgentMCPServer's `sessions` Map
- Claude API call made (token consumption)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Agent not found | `Unknown agent: {name}` | MCP error response |
| Prompt empty | `Prompt is required` | MCP error response |
| Claude query fails | Underlying error | MCP error with details |
| Agent config missing from env | `Agent configuration not available` | MCP error |

### 6. Output
- MCP ToolResult:
  ```json
  {
    "content": [{
      "type": "text",
      "text": "{\"sessionId\":\"uuid\",\"content\":\"리뷰 결과...\",\"agentName\":\"jangbi\",\"model\":\"claude-sonnet-4\"}"
    }]
  }
  ```

### 7. Observability
- Log: `agent_chat: routing to agent '{name}'`
- Log: `agent_chat: query complete (sessionId: {id}, tokens: {count})`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `AgentChat_HappyPath` | Happy Path | S4, Section 3 |
| `AgentChat_UnknownAgent` | Sad Path | S4, Section 5, Row 1 |
| `AgentChat_EmptyPrompt` | Sad Path | S4, Section 5, Row 2 |
| `AgentChat_SessionCreated` | Side-Effect | S4, Section 4 |
| `AgentChat_ResponseFormat` | Contract | S4, Section 6 |

---

## Scenario 5 — agent_reply MCP Tool

> Size: small (~20 lines)

### 1. Entry Point
- Source: MCP tool call `mcp__agent__chat-reply`
- Trigger: Main bot's Claude query continues agent conversation

### 2. Input
- MCP tool arguments:
  ```json
  {
    "sessionId": "uuid-from-previous-chat",
    "prompt": "그 부분 좀 더 자세히 설명해줘"
  }
  ```
- Validation:
  - `sessionId`: required, must exist in sessions Map
  - `prompt`: required, non-empty string

### 3. Layer Flow

#### 3a. AgentMCPServer
- Looks up `sessionId` in `sessions` Map → retrieves agent config + Claude session
- Transformation:
  - `args.sessionId` → `Session { agentName, claudeSessionId }`
  - `args.prompt` → continuation prompt

#### 3b. Claude SDK Query (continuation)
- Uses stored Claude session ID for context continuity
- Same system prompt as original agent_chat call
- Transformation:
  - `prompt` + `claudeSessionId` → continued Claude query
  - Response → `{ sessionId (new or same), content, agentName }`

### 4. Side Effects
- Session Map entry updated (new sessionId if changed)
- Claude API call

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Session not found | `Unknown session: {id}. Use 'chat' first.` | MCP error |
| Claude query fails | Underlying error | MCP error |

### 6. Output
- Same format as agent_chat response

### 7. Observability
- Log: `agent_reply: continuing session {id} with agent '{name}'`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `AgentReply_HappyPath` | Happy Path | S5, Section 3 |
| `AgentReply_UnknownSession` | Sad Path | S5, Section 5, Row 1 |
| `AgentReply_SessionContinuity` | Contract | S5, Section 3b, session preserved |

---

## Scenario 6 — Agent Prompt Loading

> Size: small (~20 lines)

### 1. Entry Point
- Source: `PromptBuilder.buildPrompt()` in agent context
- Trigger: Any query by or to a sub-agent

### 2. Input
- `agentName`: string (e.g., `"jangbi"`)
- `promptDir`: path (e.g., `"src/prompt/jangbi"`)

### 3. Layer Flow

#### 3a. PromptBuilder Construction
- When creating agent's PromptBuilder, override `PROMPT_DIR`:
  - If `promptDir` configured → use that
  - Default: `path.join(__dirname, 'prompt', agentName)`
- Transformation:
  - `agentName` → `PROMPT_DIR = src/prompt/{agentName}/`
  - `PROMPT_DIR/default.prompt` → agent's system prompt
  - `{{include:common.prompt}}` → resolves within agent dir first, falls back to parent `src/prompt/common.prompt`

#### 3b. Include Resolution
- Agent's `default.prompt` may include `{{include:common.prompt}}`
- Resolution order:
  1. `src/prompt/{agentName}/common.prompt` (agent-specific)
  2. `src/prompt/common.prompt` (shared fallback)

### 4. Side Effects
- None (pure file reads)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Agent prompt dir missing | Falls back to main `src/prompt/` | Log warning |
| Agent default.prompt missing | Uses main default.prompt | Log warning |

### 6. Output
- Complete system prompt string for the agent

### 7. Observability
- Log: `PromptBuilder: loaded agent prompt from {dir}`
- Log on fallback: `PromptBuilder: agent '{name}' using main prompt (no agent-specific prompt found)`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `AgentPrompt_LoadsAgentDir` | Happy Path | S6, Section 3a |
| `AgentPrompt_FallbackToMain` | Sad Path | S6, Section 5, Row 1 |
| `AgentPrompt_IncludeResolution` | Contract | S6, Section 3b, include fallback chain |

---

## Scenario 7 — Agent Graceful Shutdown

> Size: tiny (~10 lines)

### 1. Entry Point
- Source: `AgentManager.stopAll()` in `src/agent-manager.ts`
- Trigger: SIGTERM/SIGINT handler in `index.ts`

### 2. Input
- No parameters

### 3. Layer Flow

#### 3a. AgentManager
- Iterates all `AgentInstance`s
- Calls `instance.stop()` for each

#### 3b. AgentInstance
- Saves sessions (agent's SessionRegistry)
- Disconnects Slack Socket Mode: `app.stop()`
- Cleanup resources

### 4. Side Effects
- Sessions persisted to disk (agent-scoped file)
- WebSocket connections closed

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Agent stop fails | Log error | Continue stopping other agents |

### 6. Output
- All agents stopped, resources freed

### 7. Observability
- Log per agent: `Agent '{name}' stopped`
- Log summary: `AgentManager: all agents stopped`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `AgentShutdown_StopsAll` | Happy Path | S7, Section 3a |
| `AgentShutdown_PartialFailure_Continues` | Sad Path | S7, Section 5 |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| AgentMCPServer는 child process로 실행 (기존 패턴) | small | 모든 MCP 서버가 동일 방식 |
| agent_chat은 자체 ClaudeHandler 생성 (env로 config 전달) | small | LLM 서버가 CLI를 래핑하듯, 에이전트 서버가 Claude를 래핑 |
| 프롬프트 include 해석 시 agent dir → parent dir 순서 | tiny | 직관적 override 패턴 |
| 에이전트별 독립 SessionRegistry | small | 세션 키 충돌 방지 |
| 에이전트 시작 실패 시 skip & continue | tiny | 메인 봇 안정성 우선 |
| 에이전트 세션 파일은 `{DATA_DIR}/agent-{name}-sessions.json` | tiny | 기존 sessions.json 패턴 따름 |

## Implementation Status

| # | Scenario | Size | Trace | Tests (RED) | Status |
|---|----------|------|-------|-------------|--------|
| 1 | Agent Config Parsing | small | done | RED | Ready |
| 2 | Agent Startup Lifecycle | medium | done | RED | Ready |
| 3 | User Direct Chat with Sub-Agent | small | done | RED | Ready |
| 4 | agent_chat MCP Tool | medium | done | RED | Ready |
| 5 | agent_reply MCP Tool | small | done | RED | Ready |
| 6 | Agent Prompt Loading | small | done | RED | Ready |
| 7 | Agent Graceful Shutdown | tiny | done | RED | Ready |

## Next Step

→ Proceed with implementation + Trace Verify via `stv:work`
→ Recommended order: S1 → S6 → S2 → S7 → S4 → S5 → S3
→ (Config → Prompt → Lifecycle → MCP Tools → Integration)
