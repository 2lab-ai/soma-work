# somawork Clean-Machine Verification and Preview Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the published package and `somawork setup` journey on a clean macOS ARM64 user, publish a shareable receipt, then roll the verified preview artifact to the configured preview fleet.

**Architecture:** Verification uses a fresh user/config/state boundary and published artifacts only. Provider OAuth is newly minted in the clean context; no rotating token is copied. The receipt captures terminal output, provider-safe status, package identity, permissions, process health, and an actual Slack response.

**Tech Stack:** xbrew/Homebrew, macOS user/launchd, Slack CLI, llmux, soma-work, HTML receipt.

**Spec:** `docs/superpowers/specs/2026-08-23-somawork-setup-onboarding-verification.md`

## Global Constraints

- Do not reuse `~/.config/llmux.json`, `~/.codex/auth.json`, `~/.slack/credentials.json`, or soma-work `.env` from another user.
- Human provider approvals are allowed; credential copy is not.
- A scratch receipt is deployment qualification; preview deployment requires a post-deploy real-fleet smoke.
- No stable release or production service activation in this plan.

---

### Task 1: Provision clean-user verification boundary

- [ ] Use a dedicated macOS ARM64 user account or equivalent isolated HOME+Keychain session with no prior tool state; prove absence with path checks.
- [ ] Install xbrew from its public installer and `xbrew install somawork-preview` from published artifacts.
- [ ] Capture package versions, release manifest/source SHA, brew receipts, and runtime tree.
- [ ] Verify no source checkout, GH token, or existing user config was consulted.

### Task 2: Execute real onboarding

- [ ] Run `somawork setup --profile preview` and capture redacted terminal output.
- [ ] Complete fresh Claude OAuth and fresh Codex OAuth in provider browsers; verify `llmux accounts --json` has healthy claude+codex groups.
- [ ] Complete Slack ticket/confirm/challenge and app-install approval; verify no xoxb/xapp was typed, printed, or stored in setup state.
- [ ] Verify doctor JSON all-green, profile permissions, LaunchAgent/headless liveness, and restart persistence.
- [ ] Send an actual Slack DM/mention and capture the response permalink plus safe service log lines.

### Task 3: Adversarial resume and coexistence checks

- [ ] Interrupt a second profile setup after llmux and resume; prove no duplicate provider accounts.
- [ ] Install/setup production profile beside preview with a separate Slack app or mock Slack capture if production external send is not authorized; prove labels/paths/PIDs do not collide.
- [ ] Simulate Slack capture timeout and post-start doctor failure in the isolated harness; prove app ID resume and service rollback.

### Task 4: Gate, review, and receipt HTML

- [ ] Directly rerun soma-work typecheck, focused setup tests, full Vitest, build, package smokes; rerun tap and xbrew gates.
- [ ] Run external code review per repo on the final diffs and resolve all blocking findings.
- [ ] Build receipt HTML with `AS-IS → root cause/file evidence → implementation → gate outputs → live captures → QA reproduction`, publish through the available report server, and record the URL.
- [ ] Update implementation-plan checkboxes and docs completed-work ledger.

### Task 5: Preview rollout

- [ ] Merge/push only after gates, review, CI, published-package install, and clean-user live receipt are green.
- [ ] Trigger preview release→tap bump→`xbrew upgrade somawork-preview` on configured preview targets; do not touch production profile.
- [ ] On each live preview target, verify installed source SHA/version, service PID/restart count, llmux connectivity, Slack Socket Mode, and one actual message response.
- [ ] If any target fails, rollback that target to the previous formula version and keep the rest unchanged.
- [ ] Report preview artifact/version, target matrix, receipts, and remaining production gate.
