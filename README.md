# Claude Code Slack Bot

> *"In the beginning was the Word, and the Word was Code."*

A TypeScript bot that summons AI coding intelligence into your Slack workspace.
Powered by the Claude Code SDK, it provides a conversational coding assistant with 12 genius personas, automatic workflow dispatch, an extensible MCP tool ecosystem, and real-time task tracking.

[한국어 README](./README.ko.md)

---

## What It Does

Send a DM, mention in a channel, or talk in a thread.
The bot remembers context, reads code, analyzes files, reviews PRs, organizes Jira issues, and writes Confluence docs.

```
You:    Review this PR https://github.com/org/repo/pull/42
Bot:    [Analyzes the PR, reads the code, writes review comments]

You:    Summarize issue PTN-1234
Bot:    [Fetches from Jira, analyzes related PRs/code, generates executive summary]

You:    Optimize this function [file upload]
Bot:    [Analyzes the file, finds bottlenecks, suggests optimized code]
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Slack Events                     │
│              (DM / Mention / Thread)                │
└──────────────────────┬──────────────────────────────┘
                       │
                ┌──────▼──────┐
                │ SlackHandler │ ← Facade
                │   (314 LOC)  │
                └──────┬──────┘
                       │
          ┌────────────┼────────────────┐
          │            │                │
   ┌──────▼──────┐ ┌──▼───────┐ ┌─────▼──────┐
   │ EventRouter │ │ Command  │ │  Stream    │
   │   (272)     │ │ Router   │ │ Processor  │
   │             │ │  (95)    │ │  (512)     │
   └──────┬──────┘ └──┬───────┘ └─────┬──────┘
          │            │                │
          │     ┌──────▼──────┐  ┌─────▼──────┐
          │     │ 14 Command  │  │  Pipeline  │
          │     │  Handlers   │  │ input →    │
          │     └─────────────┘  │ session →  │
          │                      │ stream     │
          │                      └─────┬──────┘
          │                            │
   ┌──────▼────────────────────────────▼──────┐
   │              ClaudeHandler               │
   │                (381 LOC)                 │
   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
   │  │ Session  │ │ Prompt   │ │ Dispatch │ │
   │  │ Registry │ │ Builder  │ │ Service  │ │
   │  │  (522)   │ │  (298)   │ │  (368)   │ │
   │  └──────────┘ └──────────┘ └──────────┘ │
   └──────────────────┬───────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
   │   MCP   │  │ GitHub  │  │ Permis- │
   │ Manager │  │  Auth   │  │  sion   │
   └─────────┘  └─────────┘  └─────────┘
```

**Facade Pattern**: Three facades (`SlackHandler`, `ClaudeHandler`, `McpManager`) present simple interfaces over complex subsystems.

## Features

### Workflow Dispatch
Analyzes user input and automatically selects the optimal workflow.

| Workflow | Trigger | Action |
|----------|---------|--------|
| PR Review | Contains PR URL | Code review + comments |
| PR Fix & Update | "fix" + PR | Code fix + commit + push |
| PR Docs | "document" + PR | Confluence page generation |
| Jira Planning | Jira issue + planning | Task decomposition + planning |
| Jira Summary | Jira issue + summary | Executive report generation |
| Jira Brainstorming | Jira + brainstorm | Idea divergence + synthesis |
| Default | All other input | General-purpose coding assistant |

### 12 Personas
Switch the bot's personality and thinking style. Use `persona einstein` to think like Einstein, or `persona linus` for Linus Torvalds' code review style.

`default` `chaechae` `linus` `buddha` `davinci` `einstein` `elon` `feynman` `jesus` `newton` `turing` `vonneumann`

### Real-Time Task Tracking
Tracks Claude's in-progress tasks in real time and displays them in Slack.

### MCP Integration
Connect MCP servers via stdio/SSE/HTTP protocols to infinitely extend Claude's toolset. Tracks call statistics and estimated completion times.

### Interactive Actions
Handles permission approvals, option prompts, and session management interactively through Slack buttons and forms.

### File Analysis
Upload images (JPG/PNG/GIF/WebP), text, or code files for analysis and prompt injection. 50MB limit.

### GitHub Integration
GitHub App authentication (recommended) or PAT fallback. Automatic token renewal for seamless Git operations.

## Commands

| Command | Description |
|---------|-------------|
| `cwd` | Show current working directory |
| `mcp` / `mcp reload` | List MCP servers / reload config |
| `persona [name]` | Switch persona |
| `model [name]` | Switch model (sonnet, opus, haiku) |
| `sessions` | List active sessions |
| `new [prompt]` | Reset current session and continue with empty memory |
| `renew [prompt]` | Renew session (optionally retain prompt) |
| `restore [session]` | Restore a session |
| `terminate [session]` | Terminate a session |
| `context` | Show context window status |
| `help` | Show help |

## Quick Start

### 1. Clone & Install

```bash
git clone <repo-url>
cd claude-code-slack-bot
npm install
```

### 2. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From an app manifest**
3. Paste the contents of `slack-app-manifest.json` (or `.yaml`)
4. After creating the app:
   - **OAuth & Permissions** → copy Bot User OAuth Token (`xoxb-...`)
   - **Basic Information** → generate App-Level Token (`connections:write` scope, `xapp-...`)
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
BASE_DIRECTORY=/path/to/code/   # Base for per-user working directories

# Optional
ANTHROPIC_API_KEY=...           # Only needed without Claude Code subscription
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA..."
GITHUB_INSTALLATION_ID=12345678
GITHUB_TOKEN=ghp_...            # Fallback when GitHub App not configured
CLAUDE_CODE_USE_BEDROCK=1       # Use AWS Bedrock
CLAUDE_CODE_USE_VERTEX=1        # Use Google Vertex AI
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
npm run dev      # Development (watch mode)
npm start        # Development (tsx)
npm run build && npm run prod  # Production
```

## Deployment

### Docker

```bash
docker-compose up -d
docker-compose logs -f
```

### macOS LaunchAgent

```bash
./service.sh install     # Install service
./service.sh start       # Start
./service.sh logs follow # Stream logs
```

Service name: `com.dd.claude-slack-bot`. Auto-restarts on crash.

> **Warning**: Do not use `service.sh` during development. Running multiple instances with the same Slack token causes message conflicts.

## GitHub Integration

### GitHub App (Recommended)

1. Create an app at [GitHub Developer Settings](https://github.com/settings/apps)
2. Permissions: Contents (RW), Issues (RW), Pull Requests (RW), Metadata (R)
3. Generate and download a Private Key
4. Install the app on your repositories, note the Installation ID
5. Set `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` in `.env`

### Personal Access Token (Fallback)

1. GitHub Settings → Developer Settings → Personal Access Tokens
2. Select `repo`, `read:org` scopes
3. Set `GITHUB_TOKEN` in `.env`

When GitHub App is configured, it takes priority. Otherwise falls back to PAT.

## Project Structure

```
src/                            # ~13,800 lines of TypeScript
├── slack/                      # Slack module (SRP separation)
│   ├── actions/                # Interactive action handlers (7 files)
│   ├── pipeline/               # Stream processing pipeline (5 files)
│   ├── commands/               # Command handlers (14 files)
│   └── formatters/             # Output formatters
├── mcp/                        # MCP server management
├── github/                     # GitHub App auth + Git CLI
├── permission/                 # Permission service + Slack UI
├── prompt/                     # System prompts
│   └── workflows/              # Workflow prompts (7 workflows)
└── persona/                    # Bot personas (12 personas)

data/                           # Runtime data (auto-generated)
docs/                           # Architecture + spec docs (12 specs)
scripts/                        # Utility scripts
```

| Category | Count |
|----------|-------|
| Source (excl. test/local) | 85 files, ~13,800 LOC |
| Tests | 20 files, ~5,600 LOC |
| Personas | 12 files, ~4,700 LOC |
| Prompts | 12 files, ~1,900 LOC |

## Design Decisions

1. **Facade Pattern** — Simplifies complex subsystems behind 3 facades
2. **Single Responsibility** — One responsibility per file (85 modules)
3. **Pipeline Architecture** — Input preprocessing → session init → stream execution
4. **Workflow Dispatch** — Input classification → specialized workflow prompts
5. **Append-Only Messages** — New messages instead of message edits
6. **Session-Based Context** — Per-thread session persistence
7. **Dependency Injection** — Testability through injected dependencies

## Testing

```bash
npx vitest          # Run all tests
npx vitest run      # Single run
npx vitest --watch  # Watch mode
```

20 test files cover critical paths: event routing, stream processing, command parsing, permission validation, tool formatting, session management, and more.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Bot not responding | Check logs with `DEBUG=true`, Slack token validity, channel invitation |
| Auth errors | Verify API keys, Socket Mode enabled, token expiration |
| Broken message formatting | Markdown → Slack mrkdwn conversion limitations |
| Session conflicts | Multiple instances running with same token |

## License

MIT
