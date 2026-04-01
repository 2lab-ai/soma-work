# How to Add a New Sub-Agent

> Guide for adding independent Slack Bot sub-agents to soma-work.

---

## Overview

soma-work supports a **multi-agent architecture** where each sub-agent is an independent Slack App running within the same process. Each agent has its own:

- Slack Bot Token / App Token (separate Slack App)
- System prompt and persona
- Isolated `SessionRegistry` (no session cross-contamination)

The main bot (@soma) can delegate work to sub-agents via `agent_chat` / `agent_reply` MCP tools, and users can also @mention sub-agents directly.

> **Status**: Agents connect via Socket Mode and receive events. Full ClaudeHandler wiring for @mention/DM responses and `agent_chat` query integration is in progress (Phase 2). The infrastructure (AgentManager, AgentInstance, Agent MCP Server) is complete and tested.

```
User → @soma-jangbi "review this PR"
       → jangbi's own Slack App → jangbi's ClaudeHandler → Response

User → @soma "ask jangbi to review"
       → agent_chat("jangbi", prompt) → jangbi query → result back to soma
```

---

## Prerequisites

- soma-work codebase cloned and running
- Slack workspace admin access (to create new Slack Apps)
- Configuration Token for automated provisioning (optional but recommended)

---

## Method 1: Automated Provisioning (Recommended)

> ⚠️ **`main` branch only**: This script writes to `config.json`. On non-`main` branches, the runtime reads `config.dev.json` instead (see `src/env-paths.ts`). If you're on a feature branch, use [Method 3 (Manual Setup)](#method-3-manual-setup) and edit `config.dev.json` directly, or set `SOMA_CONFIG_DIR` to override.

The `provision-agent.ts` script automates Slack App creation, OAuth install, and config update.

### Step 1: Run the provisioner

```bash
npx tsx scripts/provision-agent.ts <agent-name> [description]
```

Example:
```bash
npx tsx scripts/provision-agent.ts jangbi "코드 리뷰 전문 에이전트"
```

### What it does automatically:

1. Validates your Configuration Token (stored in `config.json` under `configurationToken`)
2. Creates a Slack App via `apps.manifest.create` API
3. Opens OAuth flow in browser → captures Bot Token (`xoxb-`)
4. Prompts you to create App-Level Token (`xapp-`) manually (Slack API limitation)
5. Updates `config.json` with the agent entry (⚠️ always `config.json`, not `config.dev.json`)
6. Creates `src/prompt/<agent-name>/default.prompt`

### One-time setup for Configuration Token

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Scroll to **"Your App Configuration Tokens"**
3. Click **"Generate Token"** → select your workspace
4. Add to `config.json`:

```json
{
  "configurationToken": {
    "accessToken": "xoxe.xoxp-...",
    "refreshToken": "xoxe-..."
  }
}
```

---

## Method 2: Semi-Automated (Shell Script)

> ⚠️ **`main` branch only**: Like Method 1, this script writes to `config.json`. On feature branches, use [Method 3 (Manual Setup)](#method-3-manual-setup) instead.

```bash
./scripts/create-agent.sh <agent-name> [description]
```

Example:
```bash
./scripts/create-agent.sh gwanu "배포 및 인프라 전문 에이전트"
```

This generates a Slack App manifest, opens the creation URL, and prompts you to paste tokens.

---

## Method 3: Manual Setup

### Step 1: Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. Use this manifest (replace `<agent-name>` and `<description>`):

```json
{
  "display_information": {
    "name": "soma-<agent-name>",
    "description": "<description>",
    "background_color": "#4A154B"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "soma-<agent-name>",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "users:read",
        "reactions:read",
        "reactions:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["app_mention", "message.im"]
    },
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

3. After creation, collect three credentials:
   - **Bot Token** (`xoxb-...`): OAuth & Permissions → Bot User OAuth Token
   - **App Token** (`xapp-...`): Basic Information → App-Level Tokens → Generate with `connections:write` scope
   - **Signing Secret**: Basic Information → App Credentials

### Step 2: Add to config file

> **Important**: The runtime reads **`config.json`** on `main` branch, but **`config.dev.json`** on all other branches (unless `SOMA_CONFIG_DIR` is set). Edit the correct file for your current branch.

Add an entry under the `agents` key:

```json
{
  "agents": {
    "<agent-name>": {
      "slackBotToken": "xoxb-...",
      "slackAppToken": "xapp-...",
      "signingSecret": "...",
      "promptDir": "src/prompt/<agent-name>",
      "persona": "default",
      "description": "<description>",
      "model": "claude-sonnet-4-20250514"
    }
  }
}
```

**Required fields:**

| Field | Format | Description |
|-------|--------|-------------|
| `slackBotToken` | `xoxb-...` | Bot User OAuth Token |
| `slackAppToken` | `xapp-...` | App-Level Token (Socket Mode) |
| `signingSecret` | 20+ chars | Slack signing secret |

**Optional fields:**

| Field | Default | Description |
|-------|---------|-------------|
| `promptDir` | `src/prompt/<agent-name>` | Path to prompt directory |
| `persona` | `default` | Persona file name *(planned — not yet applied at runtime)* |
| `description` | — | Human-readable description |
| `model` | inherited from main | Claude model override |

### Step 3: Create Prompt Directory

```bash
mkdir -p src/prompt/<agent-name>
```

Create `src/prompt/<agent-name>/default.prompt`:

```markdown
# <Agent Name> — Sub-Agent System Prompt

<description of the agent's role, personality, expertise>

## Expertise
- Area 1
- Area 2

## Principles
1. ...
2. ...

## Communication Style
- ...

{{include:../common.prompt}}
```

**Key points:**
- `{{include:../common.prompt}}` inherits shared prompt content from the main bot
- If `default.prompt` is missing, the agent falls back to the main bot's `src/prompt/default.prompt`
- Agent-specific includes are resolved from the agent's directory first, then the main `src/prompt/` directory

### Step 4: Restart soma-work

```bash
# Development
npm run dev

# Production
npm run build && npm run prod

# macOS LaunchAgent
./service.sh restart
```

### Step 5: Test

- Direct mention: `@soma-<agent-name> 안녕!`
- DM: Open a DM with the agent bot
- Via main bot: `@soma "ask <agent-name> to review this"`

---

## How It Works Internally

### Startup Flow

```
index.ts
  → loadUnifiedConfig() reads config.json
  → parseAgentsConfig() validates agent entries
  → new AgentManager(agentConfigs, mcpManager)
  → agentManager.startAll()
      → for each agent: new AgentInstance(name, config, mcpManager)
      → instance.start() creates Slack Bolt App + Socket Mode connection
      → failure isolated: one agent failing doesn't block others
```

### Config Validation (`unified-config-loader.ts`)

Invalid agents are **skipped with a warning**, not fatal:
- Missing/invalid `slackBotToken` (must start with `xoxb-`)
- Missing/invalid `slackAppToken` (must start with `xapp-`)
- Missing/invalid `signingSecret` (min 20 chars)

### AgentManager Lifecycle

- `startAll()`: Starts all configured agents. Failed agents are removed from the registry (error isolation).
- `stopAll()`: Gracefully stops all running agents. Failures don't block others.
- `getAgent(name)`: Lookup for MCP server routing.

### Prompt Resolution (`prompt-builder.ts`)

```
PromptBuilder({ agentName: 'jangbi' })
  1. Try: src/prompt/jangbi/default.prompt  ← agent-specific
  2. Fallback: src/prompt/default.prompt     ← main bot prompt

Include resolution:
  {{include:file.prompt}}
  1. Try: src/prompt/jangbi/file.prompt      ← agent dir first
  2. Fallback: src/prompt/file.prompt         ← main dir
```

### MCP Integration (`mcp-config-builder.ts`)

When agents are configured, the `agent` MCP server is automatically registered. This provides two tools to the main bot:

- `mcp__agent__chat` — Start a new conversation with a named sub-agent
- `mcp__agent__chat-reply` — Continue an existing agent conversation

Agent configs (minus sensitive tokens) are passed to the MCP server via `SOMA_AGENT_CONFIGS` env var.

---

## Naming Conventions

| Item | Convention | Example |
|------|-----------|---------|
| Agent name | lowercase, alphanumeric, hyphens | `jangbi`, `gwanu`, `code-review` |
| Slack App display name | `soma-<agent-name>` | `soma-jangbi` |
| Config key | matches agent name | `agents.jangbi` |
| Prompt directory | `src/prompt/<agent-name>/` | `src/prompt/jangbi/` |

---

## Existing Agents

| Agent | Description | Specialty |
|-------|-------------|-----------|
| `jangbi` (장비) | Code review specialist | Bug detection, security, performance, refactoring |
| `gwanu` (관우) | DevOps & infrastructure | CI/CD, deployment, monitoring, incident response |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Agent not responding | Check `slackBotToken`/`slackAppToken` validity. Verify Socket Mode is enabled on the Slack App. |
| "Skipping agent" in logs | Config validation failed. Check token formats and signing secret length. |
| Agent using main bot's prompt | Agent-specific `default.prompt` not found. Verify `promptDir` path. |
| Duplicate Socket Mode connections | Multiple soma-work instances running. Check PID lock. |
| `agent_chat` returns "Unknown agent" | Agent name doesn't match `config.json` key. Names are case-sensitive. |
