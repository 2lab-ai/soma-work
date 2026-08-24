# somawork Setup Onboarding Verification

**Date:** 2026-08-23  
**Design:** [somawork setup onboarding](2026-08-23-somawork-setup-onboarding-design.md)

## 1. Testing and receipts

### 9.1 Unit/contract tests
- Profile inference and stable+preview coexistence.
- State-machine resume for every boundary.
- Secret-shape rejection in state/log output.
- Atomic profile writes and permission modes.
- llmux account-group classification and login skip/retry.
- Slack ticket/challenge orchestration.
- Slack capture-hook IPC success, timeout, malformed token, and child cleanup.
- Pending-admin-install and duplicate-app recovery.
- Signing-secret optionality under Socket Mode; required if an HTTP receiver is selected.
- LaunchAgent and headless fallback profile isolation.
### 9.2 Integration tests

Use fake llmux HTTP/CLI and fake Slack CLI processes for deterministic flows:
- fresh success;
- existing Claude only;
- existing Codex only;
- OAuth cancel and retry;
- multiple Slack workspaces;
- install approval pending;
- interrupted token capture;
- existing preview while adding production;
- failed post-start doctor rollback.
### 9.3 Package tests

In a fresh Homebrew prefix:
- install `somawork-preview` and verify `somawork` controller dependency;
- install `somawork` beside it;
- verify independent runtime roots and profiles;
- upgrade either runtime without changing profile data;
- uninstall one without breaking the other;
- verify xbrew resolves both friendly names through `macos.formula` recipes.
### 9.4 Live clean-machine receipt

On a clean macOS ARM64 user context with no soma-work/llmux/Slack CLI state:

1. `xbrew install somawork-preview`.
2. `somawork setup --profile preview`.
3. Complete fresh Claude and Codex OAuth (no credential copy from another machine).
4. Complete Slack ticket/challenge and app approval.
5. Confirm setup captured Slack tokens without user copy/paste.
6. Confirm doctor reports healthy Claude+Codex, Slack API, Socket Mode, profile permissions, and runtime.
7. Confirm service survives a fresh process start and responds to an actual Slack mention/DM.
8. Capture command output, service log excerpts, Slack message permalink, package versions, and filesystem permission checks in the receipt HTML.
## 2. Acceptance matrix
| User requirement | Acceptance evidence |
|---|---|
| install through brew/xbrew | fresh-prefix and clean-user installation receipts |
| `somawork setup` single entry | one command resumes/finishes the complete state machine |
| minimum user input | only provider approvals, Slack ticket paste, one challenge entry, optional workspace/profile choice |
| Claude + Codex at least one each | live llmux status shows one healthy account per group |
| Slack login and keys | Slack CLI auth + automatic `xoxb`/`xapp` capture; no token paste |
| immediate usable service | launchd/headless service green + actual Slack message response |
| preview + production coexist | both runtime packages and services operate independently on one machine |
| safe retries | every interrupted scenario resumes without duplicate apps or lost working config |
## 3. Out of scope for v1
- Linux/systemd service implementation.
- Remote llmux onboarding.
- Multiple Slack apps/agents in one setup invocation.
- GitHub App/PAT provisioning; GitHub features remain optional and can use an existing `gh auth` session later.
- Hosted onboarding portal.
- Automated Slack app icon upload.
