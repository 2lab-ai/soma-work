# somawork Setup Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the common `somawork` controller with resumable terminal setup, local llmux Claude/Codex onboarding, Slack CLI zero-token-copy capture, profile materialization, doctor, and isolated service lifecycle.

**Architecture:** A small CLI router delegates to focused onboarding adapters behind injectable process/filesystem interfaces. Setup is a typed state machine that validates live state before advancing; secrets and non-secret state use separate atomic stores. Runtime boot consumes one resolved profile contract, allowing preview and production to coexist.

**Tech Stack:** TypeScript, Node 24, Vitest, Unix sockets, Slack CLI hooks, llmux CLI/HTTP, launchd.

**Spec:** `docs/superpowers/specs/2026-08-23-somawork-setup-onboarding-design.md`

## Global Constraints

- `somawork setup` is terminal-first; only provider authorization opens browser/Slack UI.
- Slack tokens are never printed or passed in argv; capture through a profile-scoped Unix socket.
- Signing secret is optional only for Socket Mode; HTTP receiver selection must reject a missing secret.
- llmux must have one healthy `claude` and one healthy `codex` group before service install.
- Setup profile roots are user-owned and independent from Homebrew Cellar/runtime roots.
- Compatibility scripts delegate to the controller; duplicate credential collectors are deleted only after the controller tests pass.

---

### Task 1: CLI entry and profile/path contract

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/args.ts`
- Create: `src/cli/profile.ts`
- Create: `src/cli/__tests__/args.test.ts`
- Create: `src/cli/__tests__/profile.test.ts`
- Modify: `packages/common/src/env-paths.ts`
- Modify: `packages/common/src/index.ts`
- Modify: `package.json`
**Interfaces:**
- Produces: `parseCli(argv: string[]): CliCommand`; `resolveProfile(input: {requested?: string; installed: RuntimeInstall[]}): ProfileName`; `profilePaths(home: string, profile: ProfileName): ProfilePaths`; bin `somawork` → `dist/cli/index.js`.
- `ProfileName = 'preview' | 'production'`; `RuntimeInstall = {profile: ProfileName; root: string; version: string}`.
- [ ] Write failing tests for `setup/doctor/status/service/profile`, `--profile`, single-runtime inference, both-runtime ambiguity, and exact profile paths under an injected `SOMAWORK_HOME`.
- [ ] Run `npx vitest run src/cli/__tests__/args.test.ts src/cli/__tests__/profile.test.ts`; expect missing-module failures.
- [ ] Implement parser and profile/path functions; add typed `SOMA_HOME` getter to common env-paths and export it.
- [ ] Add `"bin":{"somawork":"dist/cli/index.js"}` and ensure build emits an executable shebang entry.
- [ ] Re-run focused tests and `npx tsc --noEmit`; expect PASS.
- [ ] Commit: `feat(cli): add somawork command and profile paths`.
### Task 2: Atomic setup state and secret stores

**Files:**
- Create: `src/cli/setup/state.ts`
- Create: `src/cli/setup/secrets.ts`
- Create: `src/cli/setup/__tests__/state.test.ts`
- Create: `src/cli/setup/__tests__/secrets.test.ts`
- Reuse: `packages/common/src/atomic-write.ts` and profile paths from Task 1.
**Interfaces:**
- Produces: `SetupStateStore.load/save/update`; `SecretStore.write/read`; `assertSecretFree(value: unknown): void`.
- `SetupState` contains schemaVersion, profile, currentStep, Slack app/team IDs, completed-step receipts, and lastError; no token/code/ticket field exists.
- [ ] Write RED tests for atomic temp→rename, `.bak` fallback, 0700 directories, 0600 `secrets.env`, secret-shaped value rejection (`xoxb-`, `xapp-`, OAuth/token/key/code fields), and interrupted-write recovery.
- [ ] Run focused tests; expect failures because stores do not exist.
- [ ] Implement stores using shared atomic helpers; fsync before rename and reject symlink targets.
- [ ] Re-run focused tests and verify no non-test direct `writeFileSync` is introduced.
- [ ] Commit: `feat(setup): add atomic state and secret stores`.
### Task 3: Injectable host/process boundary

**Files:**
- Create: `src/cli/setup/host.ts`
- Create: `src/cli/setup/real-host.ts`
- Create: `src/cli/setup/fake-host.ts`
- Create: `src/cli/setup/__tests__/host.test.ts`
**Interfaces:**
- Produces `SetupHost` with `command`, `spawn`, `openUrl`, `copyToClipboard`, `listenUnixSocket`, `which`, `chmod`, `launchctl`, and time functions. `CommandResult` has code/stdout/stderr with redacted display methods.
- [ ] Write RED tests proving argv/env separation, redaction of secret-shaped env/stdout, timeout/cancel propagation, and deterministic fake-host call capture.
- [ ] Implement real/fake hosts; child output goes through one redactor before terminal/log sinks.
- [ ] Re-run tests and commit: `feat(setup): add injectable host boundary`.
### Task 4: Local llmux onboarding adapter

**Files:**
- Create: `src/cli/setup/llmux.ts`
- Create: `src/cli/setup/__tests__/llmux.test.ts`
**Interfaces:**
- Consumes `SetupHost`.
- Produces `ensureLlmux(host): Promise<LlmuxReceipt>` and `classifyLlmuxAccounts(json): {claudeHealthy:number; codexHealthy:number}`.
- Commands: install `2lab-ai/tap/llmux` when missing, `llmux login`, `llmux login --codex`, `llmux restart`, `llmux accounts --json`.
- [ ] Write RED cases: neither account, Claude-only, Codex-only, both healthy, auth_failed not counted, OAuth cancel, malformed JSON, daemon readiness timeout.
- [ ] Implement skip-existing/login-missing/restart/poll logic; never parse llmux config or tokens.
- [ ] Run tests; verify command call order and no account credential in captured output.
- [ ] Commit: `feat(setup): onboard local llmux Claude and Codex accounts`.
### Task 5: Slack CLI authorization adapter

**Files:**
- Create: `src/cli/setup/slack-auth.ts`
- Create: `src/cli/setup/__tests__/slack-auth.test.ts`
**Interfaces:**
- Produces `ensureSlackCliAuth(host, requestedTeam?): Promise<SlackCliAuthReceipt>`.
- Uses `slack auth list --json` when available; otherwise parses a version-pinned text adapter. Fresh flow: `slack auth login --no-prompt` → ticket → clipboard → read challenge from terminal → `slack auth login --no-prompt --ticket X --challenge Y`.
- [ ] Write RED tests for existing single workspace, multiple-workspace selection, fresh ticket/challenge, pending/denied challenge, and ticket/challenge redaction.
- [ ] Implement adapter; store team/user IDs only, never Slack CLI developer token.
- [ ] Run tests and commit: `feat(setup): automate Slack CLI ticket authorization`.
### Task 6: Slack app manifest and token-capture hook

**Files:**
- Create: `src/cli/setup/slack-manifest.ts`
- Create: `src/cli/setup/slack-capture.ts`
- Create: `src/cli/setup/__tests__/slack-manifest.test.ts`
- Create: `src/cli/setup/__tests__/slack-capture.test.ts`
- Modify: `infra/slack/slack-app-manifest.json`
**Interfaces:**
- Produces `materializeSlackProject(profile, teamId, runtimeRoot)` and `captureSlackRuntimeTokens(host, socketPath): Promise<{botToken:string; appToken:string; appId:string; teamId:string}>`.
- Private CLI route `somawork _capture-slack-auth --socket PATH` reads `SLACK_CLI_XOXB/XAPP` (fallback standard names) and sends framed JSON over Unix socket; no stdout.
- [ ] Write RED tests for canonical scopes/events, profile-specific display name, hooks config with SDK-managed connection, socket permissions, correct capture, invalid token prefixes, timeout, child termination, and no tokens in argv/stdout/state.
- [ ] Implement temp project and framed socket capture; run `slack run --team TEAM --app APP` through `SetupHost`, retain app ID for resume, terminate after durable capture.
- [ ] Run tests and commit: `feat(setup): capture Slack runtime auth without token copy`.
### Task 7: Socket Mode signing-secret contract

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config-loader.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/agent-instance.ts`
- Test: `src/__tests__/config.preflight.test.ts`
- Test: `src/__tests__/config-loader.test.ts`
- Test: `src/__tests__/agent-manager.test.ts`
**Interfaces:**
- `signingSecret?: string`; Socket Mode construction omits it when absent. A future/configured HTTP receiver calls `requireSigningSecret` and fails closed.
- [ ] Write RED tests: main Socket Mode and multi-agent Socket Mode accept absent signing secret; short provided secret rejects; HTTP receiver fixture rejects absent secret.
- [ ] Implement optional field without weakening token prefix validation.
- [ ] Run focused tests and commit: `fix(config): make signing secret optional for Socket Mode`.
### Task 8: Profile materializer and doctor

**Files:**
- Create: `src/cli/setup/materialize.ts`
- Create: `src/cli/doctor.ts`
- Create: `src/cli/setup/__tests__/materialize.test.ts`
- Create: `src/cli/__tests__/doctor.test.ts`
**Interfaces:**
- Produces `materializeProfile(input): ProfileReceipt`; `runDoctor(profile, deps): Promise<DoctorReport>`; JSON report uses `{id,status,detail}` checks and no secrets.
- [ ] Write RED tests for atomic `runtime.env/config.json/.system.prompt`, env placeholders, 0700/0600 modes, preview+production non-collision, Slack auth.test, app-token `apps.connections.open` with URL discarded, llmux groups, writable directories, and secret-safe JSON.
- [ ] Implement materialization and doctor; use existing Slack probe helpers and runtime config loader rather than duplicating validation.
- [ ] Run tests and commit: `feat(setup): materialize profiles and add doctor`.
### Task 9: Profile-isolated service manager

**Files:**
- Create: `src/cli/service.ts`
- Create: `src/cli/__tests__/service.test.ts`
- Modify: `scripts/service.sh`
**Interfaces:**
- Produces `service install|start|stop|restart|status`; LaunchAgent labels `ai.2lab.somawork.preview|production`; runtime root comes from installed formula, config/data/log from profile paths.
- [ ] Write RED tests for distinct labels/plists/PIDs/logs, start liveness, stale registration recovery, headless fallback, and post-start doctor rollback.
- [ ] Implement manager; make `scripts/service.sh` delegate to controller when installed while retaining a source-tree fallback during transition.
- [ ] Run tests and commit: `feat(service): isolate preview and production profiles`.
### Task 10: Setup orchestrator, status, and compatibility shims

**Files:**
- Create: `src/cli/setup/orchestrator.ts`
- Create: `src/cli/setup/__tests__/orchestrator.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `scripts/setup-wizard.sh`
- Modify: `scripts/setup-wizard-macos.sh`
- Modify: `scripts/new-deploy-setup.sh`
- Modify: `scripts/provision-agent.ts`
**Interfaces:**
- Produces terminal step renderer and commands in spec; orchestrator steps inspect→llmux→Slack auth→Slack capture→materialize→doctor→service.
- [ ] Write RED integration tests for fresh success, resume at every boundary, pending Slack approval, OAuth cancel, existing preview plus production, and failed post-start rollback.
- [ ] Implement orchestrator and controller routes.
- [ ] Replace three setup scripts with deprecation shims; move reusable manifest helpers out of provision-agent and remove its config-token/manual-xapp path.
- [ ] Run setup test tree, full typecheck, and full Vitest suite.
- [ ] Commit: `feat(setup): deliver resumable somawork onboarding`.
### Task 11: Runtime bundle and docs sync

**Files:**
- Modify: `scripts/deploy/stage-bundle.sh`
- Modify: `scripts/smoke/deploy-bundle.js`
- Create: `scripts/smoke/setup-package.js`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `CLAUDE.md`
- Modify: `docs/misc/reference/architecture.md`
- Modify: `docs/runbook/add-new-deploy.md`
- Modify: `docs/archive/completed-work.md`
- [ ] Write RED smoke assertions for CLI entry, setup assets, canonical manifest, and no deprecated credential collector in the bundle.
- [ ] Update staged bundle and smoke tests.
- [ ] Run `.claude/skills/update-docs/SKILL.md` procedure; document setup/doctor/profile/service, new paths, and legacy shims in both READMEs.
- [ ] Run `npm run build`, `npm run smoke:deploy-bundle`, `npm run check`, `npx tsc --noEmit`, `npx vitest run`.
- [ ] Commit: `docs: publish somawork setup and runtime bundle contract`.
