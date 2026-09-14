# somawork Setup Onboarding Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `xbrew install somawork[-preview]` followed by one resumable `somawork setup` that provisions local llmux Claude+Codex auth, Slack auth/tokens, profile config, doctor, and a running service on a clean macOS ARM64 user.

**Architecture:** Three ordered workstreams keep code ownership and receipts isolated: core controller/setup in soma-work, public package distribution across soma-work/homebrew-tap/xbrew, then clean-user live verification and preview rollout. Each workstream has its own plan and gate; later workstreams consume only committed artifacts from the prior one.

**Tech Stack:** TypeScript/Node 24, Vitest, Slack CLI hooks, llmux CLI/HTTP, Homebrew Ruby Formulae, Rust/xbrew recipes, launchd, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-23-somawork-setup-onboarding-design.md` and `docs/superpowers/specs/2026-08-23-somawork-setup-onboarding-verification.md`

> **Status (2026-09-11):** see [`docs/misc/handoffs/2026-09-11-setup-onboarding-status.md`](../../misc/handoffs/2026-09-11-setup-onboarding-status.md) for what has actually shipped vs. what is still unproven. Workstream A/B code is merged; Workstream C (clean-machine live receipt) has no success evidence yet.

## Global Constraints

- macOS ARM64 is the complete v1 platform; do not claim Linux support.
- Common `somawork` controller and `somawork`/`somawork-preview` runtime payloads must coexist on one machine.
- No credential may enter argv, URL, stdout/stderr, setup-state JSON, or Homebrew Cellar mutable state.
- Claude/Codex tokens remain owned by llmux; Slack runtime tokens use child env → Unix socket → 0600 file.
- All config/state writes use `@soma/common/env-paths` and atomic write helpers; new env names use `SOMA_` prefix.
- Every code task follows RED → GREEN → REFACTOR and updates docs in the same commit.
- Stable release/prod activation remains user-gated; preview rollout proceeds after all receipts are green.

---

## Execution order

- [ ] **Workstream A — controller/setup core:** execute [`2026-08-23-somawork-setup-core-plan.md`](2026-08-23-somawork-setup-core-plan.md). Exit: controller commands, resumable setup, Slack/llmux adapters, doctor/service tests green; no distribution assumption. *(2026-09-11: soma-work PR #193, "fix(setup): propagate the active llmux endpoint", merged as a setup-endpoint follow-up fix — not the sole/original core implementation; full exit receipt not independently confirmed in this pass — box left unchecked, see status handoff above.)*
- [ ] **Workstream B — public packaging:** execute [`2026-08-23-somawork-packaging-plan.md`](2026-08-23-somawork-packaging-plan.md). Exit: public immutable preview assets, three tap formulae, two xbrew recipes, fresh-prefix coexistence receipt. *(2026-09-11: homebrew-tap PR #5 ("feat: package Slack CLI for somawork setup") and xbrew PR #3 ("fix: bootstrap Homebrew for brew-backed recipes") merged; fresh-prefix coexistence receipt not independently confirmed in this pass — box left unchecked, see status handoff above.)*
- [ ] **Workstream C — clean-machine receipt:** execute [`2026-08-23-somawork-clean-machine-plan.md`](2026-08-23-somawork-clean-machine-plan.md). Exit: fresh user E2E with new OAuth, actual Slack response, HTML receipt, preview fleet deployment. *(2026-09-11: historical install and incomplete OAuth attempts, no success evidence — see status handoff above.)*

## Cross-workstream handoff contract

1. Core publishes `dist/cli/index.js`, `dist/runtime/**`, and `scripts/smoke/setup-package.js` in the staged runtime bundle.
2. Packaging consumes that staged bundle without rebuilding source and emits a manifest with source SHA, channel, version, asset SHA, minimum Node, and controller/runtime layout version.
3. Clean-machine verification installs only from published tap/xbrew artifacts; source checkout execution is forbidden.
4. A failed downstream workstream reopens the producing workstream; no receipt is patched around an artifact defect.
