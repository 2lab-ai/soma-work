# Running soma-work

## Getting soma-work running

There are **two** ways in, and they are not interchangeable.

| Path | What it is | Where it stands today |
|---|---|---|
| **Packaged onboarding** — `somawork setup` | An installed, immutable macOS ARM64 runtime plus one resumable terminal wizard that brings up llmux, authorizes Slack, mints and captures the runtime tokens for you, materializes a profile, runs a doctor gate, and installs the background service. | The controller, the wizard and the runtime bundle **are implemented on this branch and pass a local staged-bundle smoke**. The Homebrew/xbrew formula is **not published**, and no clean-user or live-Slack receipt has been taken. See the status box below before following it. |
| **Source development** — clone and run | The historical path: clone the repo, create the Slack app by hand, put tokens in a local `.env`, `npm run dev`. | Supported today, and what contributors and the existing fleet deploy use. |

### Status of the packaged path

Read this before typing any command from it.

**Landed on this branch, and locally verified**

- `somawork setup | doctor | status | service | profile | sessions`, profile materialization, the Slack manifest hook, and the staged runtime-bundle contract.
- `npm run stage:bundle && npm run smoke:setup-package` stages the bundle and exercises the **staged** controller as an external consumer would: a hermetic `SOMAWORK_HOME`, a fake `HOME`, no Homebrew on `PATH`, no provider call. It checks the required paths and modes, the forbidden-file scan, `--help` / `--version`, the private Slack manifest hook against the packaged manifest, single-document JSON output, profile isolation, and a profile materialization at 0700/0600 that writes nothing into the runtime root.

**Not done yet — do not read the above as a release**

- There is **no published Homebrew formula and no xbrew recipe**. `brew install somawork` does not resolve today. Packaging, release archives and tap changes belong to a separate workstream that has not run.
- There has been **no clean-machine install, no real Slack workspace app creation, and no real `launchd` receipt**. Everything above was proved against a staged bundle on a development machine.
- Platform is **macOS ARM64 only**. No Linux support is claimed or implemented.

### A. Packaged onboarding — the supported flow once it ships

```bash
xbrew install somawork-preview   # or: xbrew install somawork   ← formula NOT published yet
somawork setup                   # profile inferred when exactly one runtime is installed
```

`somawork setup` is the whole of onboarding. It is resumable: rerun it (or `somawork setup --resume`) after any interruption and it revalidates the world rather than trusting a stale marker.

What it does, and what it deliberately does not ask you for:

| Step | Handled by | You are never asked for |
|---|---|---|
| Claude / Codex provider auth | llmux, through the official browser OAuth flows | an API key |
| Slack app create + install | Slack CLI ticket/challenge, then the packaged app manifest | a manifest paste |
| Slack runtime credentials | captured from the Slack CLI's own hook into a `0600 secrets.env` over a profile-scoped Unix socket | a `xoxb-` / `xapp-` copy-paste |
| Signing secret | not used — the manifest enables Socket Mode | a signing secret |
| Profile config, prompt, data dirs | materialized from the packaged `config.default.json` and `.system.prompt.example` | a hand-written `.env` |
| Background service | a per-profile launchd user agent | a plist |

Controller commands:

| Command | Purpose |
|---|---|
| `somawork setup [--profile preview\|production] [--resume]` | Run or resume onboarding. |
| `somawork doctor [--profile <p>] [--json]` | Diagnose a profile. `--json` emits exactly one document, with no filesystem paths in the details. |
| `somawork status [--profile <p>] [--json]` | Profile and service state. `status --json` **does** contain absolute paths (plist, pid file, log dir), so it is less safe to paste into a public issue than `doctor --json`. |
| `somawork service <install\|start\|stop\|restart\|status> [--profile <p>]` | Manage the background service. |
| `somawork profile <list\|show> [--profile <p>] [--json]` | Inspect installed profiles. `profile remove` is not available in this release and refuses. |
| `somawork sessions <list\|show> [--profile <p>] [filters]` | Query archived sessions. |
| `somawork help` · `somawork version` | Both answer without touching a runtime, a profile, or a provider. |

Profiles are fully isolated — `preview` and `production` coexist on one machine and share no path or service identity:

| | `preview` | `production` |
|---|---|---|
| config | `~/.config/somawork/profiles/preview` | `~/.config/somawork/profiles/production` |
| data | `~/.local/share/somawork/preview` | `~/.local/share/somawork/production` |
| state | `~/.local/state/somawork/preview` | `~/.local/state/somawork/production` |
| service label | `ai.2lab.somawork.preview` | `ai.2lab.somawork.production` |

`SOMAWORK_HOME` overrides the profile root and is the supported override for hermetic tests. `SOMA_HOME` is accepted as a **deprecated** alias; when both are set, `SOMAWORK_HOME` wins.

**Legacy setup entry points are compatibility shims, not a second way in.** `scripts/setup-wizard.sh`, `scripts/setup-wizard-macos.sh` and `scripts/new-deploy-setup.sh` print a deprecation notice and `exec somawork setup`. They no longer collect tokens, no longer write a repo-relative `.env`, and no longer materialize `/opt/soma-work`. `scripts/provision-agent.ts` is likewise a hard deprecation wrapper.

### B. Source development path

This is the path to use today for contributing, and the one the existing fleet deploy is built on. It is unchanged.

#### 1. Clone & install

```bash
git clone https://github.com/2lab-ai/soma-work.git
cd soma-work
npm install
npm run build    # the workspace packages load from their dist/; a clean clone must build once before it runs
```

#### 2. Create a Slack app by hand

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. Paste the contents of [`infra/slack/slack-app-manifest.json`](../../../infra/slack/slack-app-manifest.json)

   > **The manifest's app name is `Somawork`** (previously `[DEV] Claude Code Bot`). Pasting this
   > manifest into an app that was created from the older file **renames that app and its bot** in
   > the workspace. Edit the two `name` / `display_name` fields before saving if you need to keep
   > the existing name.
3. After creation:
   - **OAuth & Permissions** → copy Bot User OAuth Token (`xoxb-...`)
   - **Basic Information** → generate App-Level Token with `connections:write` scope (`xapp-...`)
   - **Basic Information** → copy Signing Secret

> On the packaged path none of this is manual — the wizard drives Slack CLI and captures the tokens
> without ever printing them. This section stays because the source checkout has no packaged runtime
> to read the manifest out of.

#### 3. Configure environment

```bash
cp .env.example .env
```

```env
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
# SLACK_SIGNING_SECRET=...  # optional: HTTP signature verification only (Socket Mode does not need it)
BASE_DIRECTORY=/path/to/code/

# Optional
ANTHROPIC_API_KEY=...              # Only needed without Claude Code subscription
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA..."
GITHUB_INSTALLATION_ID=12345678
GITHUB_TOKEN=ghp_...               # Fallback when GitHub App not configured
SOMA_PR_WATCH=off                  # Stop watching session PRs after the turn (default on: merge/close reach the card and thread)
SOMA_PR_WATCH_BOTS=coderabbitai[bot]  # Review bots whose PR reviews may wake the session (default none; members always can)
CLAUDE_CODE_USE_BEDROCK=1          # Use AWS Bedrock
CLAUDE_CODE_USE_VERTEX=1           # Use Google Vertex AI
DEBUG=true
SOMA_RELEASE_NOTES_CHANNELS=acme/app@deploy/dev2=C0123456789,*=session  # Where deploy release notes go
SOMA_LINK_LEAK_REPORT_CHANNEL=C0123456789  # Daily task-card link leak report post (off when unset); `report leaks` works without it
SOMA_LINK_LEAK_REPORT_HOUR=9               # Hour (REPORT_TIMEZONE) the leak report posts; SOMA_LINK_LEAK_BOT_LOGIN overrides the App login
```

#### 4. Configure MCP servers (optional)

Edit the `mcpServers` section of `config.json`:

```bash
cp config.example.json config.json
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

#### 5. Inject env vars into the Claude Agent SDK (optional)

The SDK is pinned to `0.3.321` (native Claude Code `2.1.321`) for Fable 5.2 (`claude-fable-5-2`; the subscription endpoint refuses Claude Code 2.1.284 with `claude_code_version_too_old`, and Anthropic asks for ≥ 2.1.321), Fable 5.1 and Opus 5.5 (`claude-opus-5-5`, requires Claude Code ≥ 2.1.280) support. Streaming turns force `CLAUDE_CODE_ENABLE_TASKS=false` and `MCP_CONNECTION_NONBLOCKING=0` to preserve the Slack TodoWrite snapshot adapter and first-turn MCP initialization. These compatibility settings are owned by the stream-options builder; they are not operator overrides.

Sometimes you need to set env vars on the SDK subprocess only (not on the
host process), for example to disable a built-in MCP server bundled with the
SDK. Add a `claude.env` block to `config.json`:

```json
{
  "claude.env": {
    "ENABLE_CLAUDEAI_MCP_SERVERS": false,
    "FOO": "bar",
    "MAX_TOKENS": 4096
  }
}
```

This is equivalent to running `ENABLE_CLAUDEAI_MCP_SERVERS=false claude ...`
as a shell prefix — the values are forwarded to every Claude Agent SDK
`query()` call across the app. Internals: `setQueryEnvAdditional` in
`src/auth/query-env-builder.ts` installs the map at boot; `buildQueryEnv`
overlays it between the inherited `process.env` and the per-lease
`CLAUDE_CODE_OAUTH_TOKEN` override.

**Value coercion.** `boolean` and finite `number` JSON values are
`String()`-coerced before injection (env-var values must be strings). Empty
string is allowed — it's the explicit "clear an inherited var" form.

**Reserved keys (denylist).** The following are dropped on load with a
warning. They are owned by the lease/auth path and operator overrides
would either re-route auth, redirect credential storage, or widen the TLS
trust surface:

- `CLAUDE_CODE_OAUTH_TOKEN` (lease token wins)
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
- `CLAUDE_CONFIG_DIR`
- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`
- `HTTP_PROXY`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`

**Restart required.** There is no hot reload — the operator must restart the
process after editing `claude.env` for changes to take effect. The boot log
prints the active key list (keys only — values are never logged) so
misconfigurations are visible.

**No `$VAR` expansion.** Values are passed verbatim. If you need shell-style
interpolation, set the variable in the host environment before launch
instead of in `claude.env`.

#### 6. Customize UI surfaces (optional)

The `ui` section of `config.json` controls what the thread header, turn-end
card and dashboard card header show, and how each field renders. Inspect the
built-in defaults in `config.default.json` (generated, do not edit), copy the
sections you want to change into `config.json`, and restart. Schema and
examples: [docs/ui-surfaces.md](../../../docs/ui-surfaces.md).

#### 7. Run

```bash
npm run dev                        # Development (watch mode)
npm start                          # Development (tsx)
npm run build && npm run prod      # Production
```

## Deployment

Two deployment models coexist, and they do not share paths, service labels, or
a setup procedure. Pick by which of the two paths above you are on.

| | Fleet deploy (legacy, in use) | Profile package (new) |
|---|---|---|
| Unit | a checkout or synced bundle at `/opt/soma-work/<env>` on a node | an installed immutable runtime + a per-user profile |
| Setup | GitHub self-hosted runner, hand-made Slack app, `.env` on the node | `somawork setup` |
| Service | `scripts/service.sh` → `ai.2lab.soma-work[.<env>]` | `somawork service install` → `ai.2lab.somawork.<profile>` |
| Runbook | [docs/runbook/add-new-deploy.md](../../../docs/runbook/add-new-deploy.md) | the packaged-onboarding section above |
| Status | current — this is what the running fleet uses | implemented, not published (see the status box above) |

### Fleet deploy — Docker

```bash
docker compose -f infra/docker/docker-compose.yml up -d
docker compose -f infra/docker/docker-compose.yml logs -f
```

### Fleet deploy — macOS LaunchAgent

```bash
./scripts/service.sh install     # Install as LaunchAgent
./scripts/service.sh start       # Start service
./scripts/service.sh logs follow # Stream logs
```

Service identifier: `ai.2lab.soma-work` — auto-restarts on crash.

> ⚠️ **Do not run `scripts/service.sh` during development.** Multiple instances with the same Slack token cause message conflicts.

### The runtime bundle both models are built from

`scripts/deploy/stage-bundle.sh` stages one immutable tree. The fleet deploy
rsyncs it to a node; the packaged path installs it as a runtime root. It carries
the daemon, the service supervisor, the executable controller entry, and the
three canonical setup assets (`config.default.json`, `.system.prompt.example`,
`infra/slack/slack-app-manifest.json`), and it carries no credential, no profile
state, no test, no source map and no TypeScript source.

```bash
npm run build
npm run stage:bundle              # → .deploy-bundle
npm run smoke:deploy-bundle       # deployment + workspace-package contract
npm run smoke:setup-package       # setup/runtime contract, as an external consumer
```

`smoke:setup-package` also mutates temporary hardlinked copies of the staged
tree — removing each setup asset and each runtime entry in turn, and injecting
each forbidden file — so a green run means the *bundle* satisfies the contract,
not merely that the source checkout happens to contain the files.

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

With the App, every token refresh also rewrites a bot-owned `gh` config (`$DATA_DIR/gh/hosts.yml`, mode 0600). While that file is written, agent shells get it as `GH_CONFIG_DIR` and no `GITHUB_TOKEN` (a failed write falls back to the env), so `gh` reads the live token on every call instead of a copy that expires an hour into a long turn. `git` already re-reads its config, which every refresh rewrites. Agent `gh` therefore does not see the operator's own `~/.config/gh` (aliases, other hosts).

## Multi-Agent Setup

Add sub-agents to `config.json` (or `config.dev.json` on non-`main` branches):

**There is no supported way to provision an additional sub-agent today.** `somawork setup`
creates the profile's primary Slack app and nothing else, and the two old provisioning scripts are
not a substitute:

- `scripts/provision-agent.ts` is a hard deprecation wrapper — it provisions nothing and exits
  nonzero. Its configuration-token storage, OAuth-callback capture and manual app-token prompt were
  removed as forbidden credential paths.
- `scripts/create-agent.sh` still runs, but it reads raw tokens from the terminal and writes them
  into a plaintext config file. **Do not run it to mint, copy, or store credentials.** It is not
  part of the packaged runtime.

Each sub-agent needs two long-lived Slack credentials, and nothing today mints or stores those the
way the primary app's are handled — so additional-agent provisioning is **unsupported, pending a
secrets-store-backed design**. An operator running sub-agents on a source checkout is accepting
plaintext credentials in a local (git-ignored) config file.

The runtime architecture, the `agents` config schema, and what a supported path would have to
provide are described in the status note:
[docs/misc/guides/how-to-new-agent.md](../../../docs/misc/guides/how-to-new-agent.md). `AgentConfig` in
`src/types.ts` is the schema's source of truth.

## Troubleshooting

| Symptom | What to Check |
|---------|---------------|
| Bot not responding | Logs (`DEBUG=true`), Slack token validity, channel invitation |
| Auth errors | API keys, Socket Mode enabled, token expiration |
| Broken formatting | Markdown → Slack mrkdwn conversion edge cases |
| Session conflicts | Multiple instances running with same Slack token |
| Sub-agent not starting | Verify `slackBotToken`/`slackAppToken` format in `config.json` |
| `agent_chat` "Unknown agent" | Agent name must match `config.json` key (case-sensitive) |
| Packaged path: anything wrong with a profile | `somawork doctor --profile <p>` — it is the gate the wizard itself runs, and its details carry no filesystem paths, so `doctor --json` is safe to paste into an issue |
| Packaged path: service not running | `somawork status --profile <p>` — note this one **does** print absolute paths |
| `brew install somawork` does not resolve | Expected. No formula is published yet; see [Status of the packaged path](#status-of-the-packaged-path) |
