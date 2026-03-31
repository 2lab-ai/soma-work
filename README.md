<h1 align="center">soma-work</h1>

<p align="center">
  <strong>AI Coding Assistant for Slack — Powered by Claude Code SDK</strong>
</p>

<p align="center">
  <a href="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml"><img src="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/2lab-ai/soma-work/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Claude_Code_SDK-0.2-7C3AED?logo=anthropic&logoColor=white" alt="Claude Code SDK" />
</p>

<p align="center">
  <a href="./README.ko.md">한국어</a>
</p>

---

## What is soma-work?

A multi-tenant Slack bot that turns every workspace conversation into an AI-powered coding session. Send a DM, mention in a channel, or reply in a thread — the bot reads code, reviews PRs, plans Jira issues, and writes solutions with full context awareness.

```
You:   Review this PR https://github.com/org/repo/pull/42
Bot:   [Analyzes diff, reads source, posts line-by-line review comments]

You:   Summarize issue PTN-1234
Bot:   [Fetches Jira issue, cross-references PRs/code, generates executive summary]

You:   Optimize this function [attaches file]
Bot:   [Analyzes uploaded code, identifies bottlenecks, proposes optimized version]
```

---

## ✨ Key Features

### 🔀 Automatic Workflow Dispatch

The bot classifies user input and routes it to the optimal workflow — no manual selection needed.

| Workflow | Trigger | What Happens |
|----------|---------|--------------|
| **PR Review** | GitHub PR URL | Full code review with inline comments |
| **PR Fix & Update** | `fix` + PR URL | Implements fix, commits, pushes |
| **PR Docs** | `document` + PR URL | Generates Confluence documentation |
| **Jira Planning** | Jira issue + `plan` | Task decomposition & work breakdown |
| **Jira Summary** | Jira issue + `summary` | Executive report generation |
| **Jira Brainstorming** | Jira issue + `brainstorm` | Idea divergence & synthesis |
| **Jira → PR** | Jira issue + `create PR` | Auto-creates pull request from issue |
| **Deploy** | Deploy-related request | Deployment workflow orchestration |
| **Onboarding** | New user / `onboarding` | Interactive guided setup |
| **Default** | Everything else | General-purpose coding assistant |

### 🎭 12 Genius Personas

Switch the bot's personality and reasoning style. Each persona brings a distinct approach to problem-solving.

```
persona einstein    → First-principles physics thinking
persona linus       → Ruthless code review, no BS
persona feynman     → "If I can't explain it simply..."
persona vonneumann  → Mathematical precision
```

Available: `default` · `chaechae` · `linus` · `buddha` · `davinci` · `einstein` · `elon` · `feynman` · `jesus` · `newton` · `turing` · `vonneumann`

### 🔌 MCP Tool Ecosystem

Connect any MCP-compatible server (stdio/SSE/HTTP) to extend Claude's capabilities infinitely. Built-in statistics tracking and estimated completion times.

### 🔐 Interactive Permissions

Slack-native button/form UX for permission approvals, option selection, and session management. Bypass mode available for trusted users.

### 📎 File Analysis

Upload images (JPG/PNG/GIF/WebP), text, or code files directly in Slack. 50MB limit per file.

### 🔑 GitHub Integration

GitHub App (recommended) or Personal Access Token authentication with automatic token renewal.

### 🤖 Multi-Agent Architecture

Run multiple independent AI agents within a single process. Each sub-agent is a separate Slack App with its own persona, system prompt, and session isolation.

```
@soma          → Main bot (제갈공명 persona)
@soma-jangbi   → Code review specialist (장비 persona)
@soma-gwanu    → DevOps & infrastructure (관우 persona)
```

- **Direct mention**: Users @mention sub-agents directly for specialized tasks
- **Delegation**: Main bot delegates via `agent_chat` MCP tool
- **Zero-config scaling**: Add agents by editing `config.json` — no code changes needed
- **Error isolation**: One agent crashing doesn't affect others

> **Note**: Direct @mention/DM handling and `agent_chat` query integration are being wired up (Phase 2). Agents currently connect via Socket Mode and receive events, but full ClaudeHandler integration is in progress.

See [How to Add a New Agent](./docs/how-to-new-agent.md) for setup instructions.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                       Slack Events                            │
│                 (DM / Mention / Thread)                       │
└──────────┬──────────────────────────────────┬─────────────────┘
           │                                  │
    ┌──────▼──────┐                  ┌────────▼─────────┐
    │ Main Bot    │                  │  AgentManager     │
    │ SlackHandler│                  │  ┌─────────────┐  │
    └──────┬──────┘                  │  │ jangbi      │  │
           │                         │  │  App+Handler│  │
  ┌────────┼──────────┐              │  └─────────────┘  │
  │        │          │              │  ┌─────────────┐  │
┌─▼──┐ ┌──▼───┐ ┌────▼───┐         │  │ gwanu       │  │
│Evt │ │ Cmd  │ │ Stream │         │  │  App+Handler│  │
│Rtr │ │ Rtr  │ │ Proc   │         │  └─────────────┘  │
└─┬──┘ └──┬───┘ └────┬───┘         └───────────────────┘
  │        │          │
  │  ┌─────▼────┐ ┌───▼──────┐
  │  │ 27 Cmd   │ │ Pipeline │
  │  │ Handlers │ │ in→sess→ │
  │  └──────────┘ │ stream   │
  │               └────┬─────┘
  │                    │
  ┌────────────────────▼──────────────────┐
  │            ClaudeHandler              │
  │ ┌──────────┐ ┌──────────┐ ┌────────┐ │
  │ │ Session  │ │ Prompt   │ │Dispatch│ │
  │ │ Registry │ │ Builder  │ │Service │ │
  │ └──────────┘ └──────────┘ └────────┘ │
  └──────────────────┬────────────────────┘
                     │
       ┌─────────────┼──────────────┐
       │             │              │
  ┌────▼────┐  ┌────▼────┐  ┌─────▼─────┐
  │   MCP   │  │ GitHub  │  │ Permission│
  │ Manager │  │  Auth   │  │  Service  │
  └────┬────┘  └─────────┘  └───────────┘
       │
  ┌────▼──────────────────────────────────┐
  │         Internal MCP Servers          │
  │  llm · model-command · slack-mcp      │
  │  cron · agent · server-tools          │
  │  permission · mcp-tool-permission     │
  └───────────────────────────────────────┘
```

**Key Facades** — `SlackHandler`, `ClaudeHandler`, `McpManager`, `AgentManager` — present simple interfaces over complex subsystems. Each module follows Single Responsibility Principle.

---

## Commands

| Command | Description |
|---------|-------------|
| `cwd [path]` | Show / set working directory |
| `mcp` · `mcp reload` | List MCP servers / reload config |
| `bypass [on\|off]` | Toggle permission bypass |
| `persona [name]` | Switch persona |
| `model [name]` | Switch model (sonnet, opus, haiku) |
| `verbosity [level]` | Set output verbosity |
| `sessions` | List active sessions |
| `new` · `renew` | Reset / renew session |
| `close` | Close current thread session |
| `restore` | Restore a session |
| `context` | Show context window status |
| `link [url]` | Attach issue/PR/doc links |
| `onboarding` | Run onboarding workflow |
| `admin` | Admin commands (accept/deny/users/config) |
| `cct` · `set_cct` | CCT token status / manual switch |
| `marketplace` | Plugin marketplace |
| `plugins` | Manage installed plugins |
| `$model` · `$verbosity` | Session-only settings (non-persistent) |
| `help` | Show help |

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/2lab-ai/soma-work.git
cd soma-work
npm install
```

### 2. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. Paste the contents of [`slack-app-manifest.json`](./slack-app-manifest.json)
3. After creation:
   - **OAuth & Permissions** → copy Bot User OAuth Token (`xoxb-...`)
   - **Basic Information** → generate App-Level Token with `connections:write` scope (`xapp-...`)
   - **Basic Information** → copy Signing Secret

### 3. Configure Environment

```bash
cp .env.example .env
```

```env
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
BASE_DIRECTORY=/path/to/code/

# Optional
ANTHROPIC_API_KEY=...              # Only needed without Claude Code subscription
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA..."
GITHUB_INSTALLATION_ID=12345678
GITHUB_TOKEN=ghp_...               # Fallback when GitHub App not configured
CLAUDE_CODE_USE_BEDROCK=1          # Use AWS Bedrock
CLAUDE_CODE_USE_VERTEX=1           # Use Google Vertex AI
DEBUG=true
```

### 4. Configure MCP Servers (Optional)

```bash
cp mcp-servers.example.json mcp-servers.json
```

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}
```

### 5. Run

```bash
npm run dev                        # Development (watch mode)
npm start                          # Development (tsx)
npm run build && npm run prod      # Production
```

---

## Deployment

### Docker

```bash
docker-compose up -d
docker-compose logs -f
```

### macOS LaunchAgent

```bash
./service.sh install     # Install as LaunchAgent
./service.sh start       # Start service
./service.sh logs follow # Stream logs
```

Service identifier: `ai.2lab.soma-work` — auto-restarts on crash.

> ⚠️ **Do not run `service.sh` during development.** Multiple instances with the same Slack token cause message conflicts.

---

## GitHub Integration

### GitHub App (Recommended)

1. Create an app at [GitHub Developer Settings](https://github.com/settings/apps)
2. Required permissions: **Contents** (RW), **Issues** (RW), **Pull Requests** (RW), **Metadata** (R)
3. Generate and download a Private Key
4. Install the app on target repositories; note the Installation ID
5. Set `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` in `.env`

### Personal Access Token (Fallback)

1. GitHub Settings → Developer Settings → Personal Access Tokens
2. Required scopes: `repo`, `read:org`
3. Set `GITHUB_TOKEN` in `.env`

GitHub App takes priority when configured. Falls back to PAT automatically.

---

## Project Structure

```
src/                                # TypeScript source
├── agent-manager.ts                # Sub-agent lifecycle management
├── agent-instance.ts               # Individual agent (Slack App + Handler)
├── slack/                          # Slack integration layer
│   ├── actions/                    # Interactive action handlers (10)
│   ├── commands/                   # Command handlers (27)
│   ├── pipeline/                   # Stream processing pipeline
│   ├── directives/                 # Channel/session link directives
│   └── formatters/                 # Output formatters
├── conversation/                   # Conversation recording & replay
├── model-commands/                 # Model command catalog & validation
├── mcp/                            # MCP server management
├── github/                         # GitHub App auth + Git CLI
├── permission/                     # Permission service + Slack UI
├── plugin/                         # Plugin system (marketplace, cache)
├── prompt/                         # System prompts
│   ├── workflows/                  # Workflow prompts (10 workflows)
│   ├── jangbi/                     # Sub-agent: code review specialist
│   └── gwanu/                      # Sub-agent: DevOps specialist
├── persona/                        # Bot personas (12 personas)
└── local/                          # Claude Code SDK extensions
    ├── agents/                     # Agent definitions (11)
    ├── skills/                     # Skill implementations
    ├── hooks/                      # Git/build hooks
    ├── commands/                   # Local slash commands
    └── prompts/                    # Local prompts

mcp-servers/                        # Internal MCP servers (extracted)
├── agent/                          # agent_chat / agent_reply tools
├── llm/                            # LLM aggregate (codex + gemini)
├── model-command/                  # Session/UI model commands
├── slack-mcp/                      # Thread context + file upload
├── cron/                           # Cron job management
├── server-tools/                   # Server administration
├── permission/                     # Permission prompt service
└── mcp-tool-permission/            # Per-tool permission gating

scripts/                            # Utility scripts
├── provision-agent.ts              # Automated sub-agent provisioning
├── create-agent.sh                 # Semi-automated agent creation
└── ...

docs/                               # Architecture & feature specs
├── how-to-new-agent.md             # Guide: adding new sub-agents
├── multi-agent/                    # Multi-agent spec & trace
└── ...
```

## Design Principles

1. **Facade Pattern** — Four facades (`SlackHandler`, `ClaudeHandler`, `McpManager`, `AgentManager`) simplify complex subsystems
2. **Single Responsibility** — One responsibility per module
3. **Pipeline Architecture** — Input preprocessing → session init → stream execution
4. **Workflow Dispatch** — Input classification → specialized workflow prompts
5. **Append-Only Messages** — New Slack messages instead of edits (reliability)
6. **Session-Based Context** — Per-thread session persistence with auto-resume
7. **Error Isolation** — Sub-agent failures don't propagate to the main bot
8. **Dependency Injection** — Testability through injected dependencies
9. **Hierarchical CWD** — Thread > Channel > User working directory priority

---

## Multi-Agent Setup

Add sub-agents to `config.json`:

```json
{
  "agents": {
    "jangbi": {
      "slackBotToken": "xoxb-...",
      "slackAppToken": "xapp-...",
      "signingSecret": "...",
      "description": "Code review specialist"
    }
  }
}
```

Automated provisioning:
```bash
npx tsx scripts/provision-agent.ts jangbi "코드 리뷰 전문 에이전트"
```

Full guide: [docs/how-to-new-agent.md](./docs/how-to-new-agent.md)

---

## Testing

```bash
npx vitest run          # Single run
npx vitest              # Watch mode
```

Test coverage includes: event routing, stream processing, command parsing, permission validation, tool formatting, session management, action handlers, pipeline processing, MCP integration, multi-agent lifecycle, and agent MCP server.

---

## Troubleshooting

| Symptom | What to Check |
|---------|---------------|
| Bot not responding | Logs (`DEBUG=true`), Slack token validity, channel invitation |
| Auth errors | API keys, Socket Mode enabled, token expiration |
| Broken formatting | Markdown → Slack mrkdwn conversion edge cases |
| Session conflicts | Multiple instances running with same Slack token |
| Sub-agent not starting | Verify `slackBotToken`/`slackAppToken` format in `config.json` |
| `agent_chat` "Unknown agent" | Agent name must match `config.json` key (case-sensitive) |

---

## License

[MIT](./LICENSE)
