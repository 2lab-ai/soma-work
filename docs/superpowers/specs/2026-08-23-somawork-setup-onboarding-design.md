# somawork Setup Onboarding Design

**Date:** 2026-08-23
**Status:** Approved design — implementation planning next
**Scope:** macOS ARM64 v1; public Homebrew/xbrew distribution; preview and production coexistence

## 1. User outcome

A new macOS ARM64 machine must reach a running soma-work deployment through one install command and one setup command:

```bash
xbrew install somawork-preview   # or: xbrew install somawork
somawork setup                   # profile inferred when only one runtime is installed
```

`somawork setup` owns the full onboarding state machine. It installs and configures local llmux, opens the official Claude and Codex browser OAuth flows, authorizes Slack through Slack CLI, captures Slack runtime tokens without copying secrets, writes profile configuration, validates every integration, installs the user service, and proves the process is live.

The setup remains terminal-first. Provider-owned browser or Slack UI opens only when provider authorization requires it.

## 2. Explicit decisions

1. **Distribution is public.** Clean machines install without a GitHub login. Publishing the currently private source repository is a separate outward-facing gate; the implementation may use a public source repository only after the existing public-readiness gate passes.
2. **One common controller, two coexisting runtimes.** `somawork` and `somawork-preview` may be installed and run together on one machine.
3. **Terminal wizard, not a localhost setup website.** The terminal renders progress and recovery instructions; Claude and Codex OAuth open provider pages in the browser.
4. **Slack token copy/paste is zero.** Slack CLI creates/installs the app and injects `xoxb`/`xapp` into an SDK-managed start hook. A one-shot capture helper persists those values without printing them.
5. **Local llmux is installed automatically.** Remote llmux topology is not part of v1.
6. **macOS ARM64 is the first complete platform.** Linux/systemd is a later vertical slice, not a partial promise in v1.
## 3. Ground-truth constraints

### 3.1 soma-work runtime requirements

Current boot requires Slack bot token, app token, and signing secret; it also requires `BASE_DIRECTORY`. In llmux mode it points Claude Agent SDK subprocesses at `http://localhost:3456` with a non-secret placeholder key. The preflight already verifies token prefixes, Slack `auth.test`, llmux mode, GitHub configuration, and base-directory existence.

For a Socket Mode receiver, Slack signing-secret verification is not exercised. Bolt requires a signing secret only for its default HTTP receiver; the current main path supplies a custom `SocketModeReceiver`, while the multi-agent path sets `socketMode: true`. The new profile contract therefore makes signing secret optional in Socket Mode while retaining support for existing values. Any future HTTP receiver must require it again.

### 3.2 llmux authentication

llmux already owns both OAuth implementations and atomic credential persistence:
- `llmux login` opens Claude PKCE browser OAuth and writes a `claude:*` account.
- `llmux login --codex` opens ChatGPT/Codex browser OAuth and writes a `codex:*` account; it may import `~/.codex/auth.json` only as a documented fallback.
- `llmux accounts --json` / `/llmux/status` expose account group and health without exposing tokens.
- The default config is `~/.config/llmux.json`, mode 0600, with atomic read-merge-write.
- `llmux restart` starts a detached local daemon on `config.proxy.port`; readiness is polled on that port, which is 3456 only by default. In local mode `llmux env` prints `export ANTHROPIC_BASE_URL=http://localhost:<configured port>` (plus the proxy api key when one is set) and is the only thing that knows which port this machine's llmux serves — the same uid may already run another llmux on 3456. `llmux env` is not unconditionally local: it shares `resolve_endpoint` with the other subcommands and prints the configured `remote.host` endpoint when one is set. Setup never reaches that case — a remote-configured llmux is refused at step one, where `llmux accounts` returns a live JSON document instead of a roster — so no remote branch is needed at the `env` read.
The setup controller never handles, copies, or parses Claude/Codex tokens. It only invokes the official llmux CLI and validates account-group health.

### 3.3 Slack authorization

Official Slack contracts impose unavoidable human authorization:

1. `slack auth login --no-prompt` returns an authorization ticket.
2. The user sends `/slackauthticket …` in their target workspace, confirms the modal, and copies the challenge code into the terminal.
3. `slack auth login --ticket … --challenge …` persists Slack CLI authorization in `~/.slack/credentials.json`.
4. `slack run` creates the app from the local manifest, asks for the target workspace when multiple authorizations exist, installs the app, and creates the Socket Mode app token.
5. For an SDK-managed start hook, Slack CLI injects `SLACK_BOT_TOKEN`/`SLACK_CLI_XOXB` and `SLACK_APP_TOKEN`/`SLACK_CLI_XAPP` into the hook process.
The old setup scripts stopped after `slack run` and required manual token copying. The new controller consumes the official injected variables through a one-shot capture hook, eliminating token copy/paste.

## 4. Package architecture

### 4.1 Formulae
| Formula | Responsibility | Linked executable |
|---|---|---|
| `somawork-cli` | Common controller, setup state machine, doctor/status/service/profile commands | `somawork` |
| `somawork-preview` | Preview runtime payload and assets | none |
| `somawork` | Production runtime payload and assets | none; depends on `somawork-cli` |
`somawork-preview` also depends on `somawork-cli`. The runtime formulae do not install a shared binary or a Homebrew service, so they cannot conflict. The controller discovers runtime roots through `brew --prefix somawork[-preview]`.

The xbrew recipes map friendly names to fully qualified Homebrew formulae:
- `somawork-preview` → `2lab-ai/tap/somawork-preview`
- `somawork` → `2lab-ai/tap/somawork`
xbrew gains a general `macos.formula` recipe field rather than a soma-work-only shell installer.

### 4.2 Profile paths
| Data | Preview | Production |
|---|---|---|
| config | `~/.config/somawork/profiles/preview/` | `~/.config/somawork/profiles/production/` |
| secret env | `…/secrets.env` (0600) | `…/secrets.env` (0600) |
| mutable data | `~/.local/share/somawork/preview/` | `~/.local/share/somawork/production/` |
| logs/state | `~/.local/state/somawork/preview/` | `~/.local/state/somawork/production/` |
| service label | `ai.2lab.somawork.preview` | `ai.2lab.somawork.production` |
No mutable data or credential lives in a Homebrew Cellar path. Upgrade/uninstall never deletes profile state.

### 4.3 Command surface

```text
somawork setup [--profile preview|production] [--resume]
somawork doctor [--profile ...] [--json]
somawork status [--profile ...] [--json]
somawork service install|start|stop|restart|status [--profile ...]
somawork profile list|show|remove
```

If exactly one runtime is installed, `setup` infers its profile. If both are installed and no profile is supplied, the wizard asks one non-secret choice. Every command accepts `SOMAWORK_HOME` for hermetic tests.

## 5. Setup state machine

Setup is idempotent and resumable. The state file contains step identifiers, non-secret resource IDs, timestamps, and verification outcomes; it never contains credentials.

### Step 0 — inspect
- Detect installed runtime(s), architecture, Homebrew/xbrew, Node, Slack CLI, and llmux.
- Resolve profile and runtime root.
- Refuse unsupported OS/architecture with a precise recovery message.
- Detect an existing legacy `/opt/soma-work/{dev,main}` install and offer an explicit import path; never overwrite it silently.
### Step 1 — local llmux
- Install stable llmux through xbrew or the tap if absent.
- Inspect `llmux accounts --json` before mutating anything.
- If no healthy Claude-group account exists, invoke `llmux login` and wait for its browser OAuth to finish.
- If no healthy Codex-group account exists, invoke `llmux login --codex` and wait for its browser OAuth to finish.
- Invoke `llmux restart`, poll readiness, then require at least one healthy account in each group.
- Once healthy, read `llmux env` and reduce it, at the parser, to one validated loopback origin. The api key line it may print is discarded and never persisted, returned, or logged. That origin is the endpoint the rest of setup uses.
- Never clone or reuse an existing refresh token in a test/scratch config.
### Step 2 — Slack CLI authorization
- Install Slack CLI if absent.
- If the selected workspace is already authorized, reuse it.
- Otherwise run `slack auth login --no-prompt`, copy the generated `/slackauthticket` command to the clipboard, and display it once.
- The user sends it in Slack, confirms the modal, and enters the returned challenge in the terminal.
- Complete login non-interactively with ticket+challenge and verify with `slack auth list`.
- If multiple workspaces are authorized, ask the user to choose once; persist only the team ID, not the developer credential.
### Step 3 — Slack app creation and token capture
- Materialize a temporary Slack CLI project under the profile state directory with the canonical soma-work manifest and SDK-managed connection hook config.
- Use neutral profile-specific app names and the chosen team ID.
- Run `slack run` as a child process. Slack CLI creates/updates the manifest app and performs developer installation.
- The start hook invokes a private controller subcommand (`somawork _capture-slack-auth`) with the runtime tokens in its environment.
- The capture helper writes `xoxb` and `xapp` through a profile-scoped Unix socket to the parent. Neither stdout, argv, URL, state JSON, nor shell history contains the values.
- The parent atomically writes `secrets.env` mode 0600, records app/team IDs, then terminates the temporary `slack run` process after installation is durable.
- Re-runs link to the recorded app ID and update/reinstall instead of creating duplicates.
- Signing secret is omitted for Socket Mode. Existing imported profiles may retain it.
### Step 4 — profile materialization

Atomically write:
- `secrets.env`: Slack bot/app tokens only.
- `runtime.env`: `AUTH_MODE=llmux`, `ANTHROPIC_BASE_URL=<the origin Step 1 read from `llmux env`>` (not a fixed port), placeholder API key, `BASE_DIRECTORY`, profile/runtime/data/log paths.
- `config.json`: canonical defaults plus any Slack-agent declaration using env placeholders.
- `.system.prompt`: packaged default or selected persona.
The wizard creates all directories with user-only permissions and validates that no secret appears in non-secret files.

### Step 5 — doctor

The setup does not install/start the service until all mandatory checks pass:
- llmux daemon responds at the endpoint written in the profile's own `.env` and has healthy `claude` and `codex` account groups.
- Slack bot token passes `auth.test`.
- Slack app token passes `apps.connections.open` without logging the returned WebSocket URL.
- Runtime and base-directory paths exist and are writable.
- `config.json` parses, placeholders resolve, and runtime preflight has no errors.
- Profile permissions are 0700; secret file is 0600.
- Stable and preview labels/ports/paths do not collide.
Doctor output is secret-safe and available as JSON for CI receipts.

### Step 6 — service and live readiness
- Install a profile-specific LaunchAgent owned by `somawork-cli`.
- Start through launchd; if no GUI/Aqua seat exists, use the existing headless supervisor fallback under the profile paths.
- Require a live process, a valid PID file, Slack Socket Mode connected state, and a successful post-start doctor.
- Print a concise completion card with profile, workspace, bot identity, runtime version, llmux account-group counts, and exact status/log commands.
## 6. Failure and recovery semantics
- Every step revalidates live state before trusting a completion marker.
- Cancellation of Claude/Codex OAuth leaves no partial account and resumes at the same provider.
- Pending Slack admin approval records app/team ID and exits with a resumable status; re-running does not create another app.
- If token capture times out, the child `slack run` is terminated, the app ID is retained, and setup resumes installation/capture.
- Config writes are temp-file + fsync + rename. Failed validation never replaces a working profile.
- Service installation is the final mutation and is rolled back if post-start doctor fails.
- `somawork setup --resume` and plain `somawork setup` are equivalent after an interrupted run.
## 7. Security model
- Setup binds no public listener and runs no hosted onboarding service.
- Provider credentials are minted and stored by provider-owned clients: llmux for Claude/Codex; Slack CLI for developer auth.
- Runtime Slack tokens traverse only child environment → local capture helper → Unix socket → 0600 secret file.
- Logs redact token prefixes, OAuth codes, ticket/challenge values, WebSocket URLs, and llmux admin keys.
- The setup state is explicitly schema-validated to reject secret-shaped values.
- `doctor --json` contains booleans, IDs safe for operations, and masked account names only.
- Browser authorization is always provider-originated; the CLI prints the destination origin before opening it.
## 8. Migration and deletion

The following old entrypoints become compatibility shims that invoke `somawork setup` and print a deprecation note:
- `scripts/setup-wizard.sh`
- `scripts/setup-wizard-macos.sh`
- `scripts/new-deploy-setup.sh`
Reusable Slack manifest/OAuth logic from `scripts/provision-agent.ts` moves behind the new Slack adapter. Its configuration-token storage in `config.json`, manual app-token prompt, and prompt-directory side effect are removed. Duplicate manual token collection paths under `scripts/setup/` are deleted after the new clean-machine receipt passes.

## 9. Verification pointer

The full test matrix, clean-machine receipt, requirement-to-evidence mapping, and v1 exclusions are in [the verification companion](2026-08-23-somawork-setup-onboarding-verification.md).
