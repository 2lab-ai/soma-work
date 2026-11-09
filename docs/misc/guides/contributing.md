# Working on soma-work

## Documentation

- Start with the [docs map](../../../docs/README.md) for current architecture, specs, traces, archives, and routing rules.
- Durable decisions live in the [ADR index](../../../docs/adr/README.md).
- Completed or archived work is tracked in the [completed work ledger](../../../docs/archive/completed-work.md).
- The 2026-05-18 research note on AI-agent-friendly project documentation is in [docs/research](../../../docs/misc/research/2026-05-18-ai-agent-docs-organization.md).
- Slack Block Kit/API constraints are maintained in [docs/misc/reference/slack-block-kit.md](../../../docs/misc/reference/slack-block-kit.md).

## Project Structure

> Counts drift — always check the directories themselves. Full component wiring: [docs/misc/reference/architecture.md](../../../docs/misc/reference/architecture.md).

```
src/                                # TypeScript source
├── agent-manager.ts                # Sub-agent lifecycle management
├── agent-instance.ts               # Individual agent (Slack App + Handler)
├── agent-runtime/                  # Claude Agent SDK execution runtime
├── slack/                          # Slack integration layer
│   ├── actions/                    # Interactive action handlers
│   ├── commands/                   # Command handlers
│   ├── pipeline/                   # Stream processing pipeline
│   ├── directives/                 # Channel/session link directives
│   ├── formatters/                 # Output formatters
│   └── z/                          # /z command surface + non-admin DM input gate
├── auth/                           # CCT lease + query env injection
├── conversation/                   # Conversation recording & replay
├── model-commands/                 # Model command catalog & validation
├── mcp/                            # MCP server management
├── github/                         # GitHub App auth + Git CLI
├── permission/                     # Permission service + Slack UI
├── plugin/                         # Plugin system (marketplace, cache)
├── prompt/                         # System prompts
│   ├── workflows/                  # Dispatch workflow prompts
│   ├── jangbi/                     # Sub-agent: code review specialist
│   └── gwanu/                      # Sub-agent: DevOps specialist
├── persona/                        # Bot personas
├── sandbox/                        # Execution sandbox gate
├── metrics/                        # Token/cost telemetry
├── notification-channels/          # Slack · DM · Telegram · Webhook routing
├── local-harness/                  # soma-work-only plugin `local` (harness skills: auto-es)
└── local/                          # Claude Code SDK extensions (plugin `zworkflow`, portable)
    ├── agents/                     # Agent definitions
    ├── skills/                     # Skill implementations
    ├── hooks/                      # Git/build hooks
    ├── commands/                   # Local slash commands
    └── prompts/                    # Local prompts

packages/                           # Workspace packages
├── mcp-servers/                    # Internal MCP servers
│   ├── agent/                      # agent_chat / agent_reply tools
│   ├── model-command/              # Session/UI model commands
│   ├── slack-mcp/                  # Thread context + file upload
│   ├── cron/                       # Cron job management
│   ├── server-tools/               # Server administration
│   ├── devops-tools/               # Keyless relay to the devops broker (gh / Cloudflare)
│   ├── permission/                 # Permission prompt service
│   └── mcp-tool-permission/        # Per-tool permission gating
├── devops-broker/                  # Separate-OS-user broker: holds gh tokens + Cloudflare forge keys, admin-approved via its own Slack app
├── common/ · slack/ · process-shared/ · test-utils/

somalib/                            # Shared soma-family library
services/a2t/                       # Audio-to-text Python worker
infra/                              # docker / slack manifest / claude config
scripts/                            # deploy staging, smokes, service.sh, deprecation shims
├── deploy/stage-bundle.sh          # builds the immutable runtime bundle
├── smoke/setup-package.js          # staged-bundle setup/runtime contract
└── setup/                          # DEPRECATED shell collector — unreachable, not bundled

docs/                               # Architecture & feature specs
└── README.md                       # Docs routing map — start here
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

## Testing

```bash
npx vitest run          # Single run
npx vitest              # Watch mode
```

Test coverage includes: event routing, stream processing, command parsing, permission validation, tool formatting, session management, action handlers, pipeline processing, MCP integration, multi-agent lifecycle, and agent MCP server.
