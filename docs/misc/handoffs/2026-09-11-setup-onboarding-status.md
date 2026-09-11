# somawork Setup Onboarding — Status

Date: 2026-09-11
Related: [master plan](../../superpowers/plans/2026-08-23-somawork-setup-master-plan.md) ·
[clean-machine plan](../../superpowers/plans/2026-08-23-somawork-clean-machine-plan.md) ·
[verification spec](../../superpowers/specs/2026-08-23-somawork-setup-onboarding-verification.md)

## Summary

Workstream A/B code has shipped and merged (controller/setup core, public packaging). Clean-machine
live acceptance (Workstream C) has **not** been achieved: there is a historical install and
incomplete OAuth attempts, and the retained evidence is only partially available. Do not read
merged PRs as a completed onboarding receipt.

## What shipped (merged, code-level)

- soma-work PR [#193](https://github.com/2lab-ai/soma-work/pull/193) — "fix(setup): propagate the
  active llmux endpoint" — merged. This is a setup-endpoint follow-up fix, not the sole/original
  core implementation; do not read it as "all of Workstream A shipped via #193".
- homebrew-tap PR [#5](https://github.com/2lab-ai/homebrew-tap/pull/5) — "feat: package Slack CLI
  for somawork setup" — merged.
- xbrew PR [#3](https://github.com/2lab-ai/xbrew/pull/3) — "fix: bootstrap Homebrew for
  brew-backed recipes" — merged, commit `629b1c009b493570ccc81730a8401ebe757aa99a`.

## Historical install evidence (2026-08-26, partial only)

- Public xbrew preview build `preview-2026-08-26-1920-629b1c009b49` installed `somawork-preview`
  with one `xbrew install` command.
- Clean-HOME path checks were observed for the target user (valid partial evidence). Separately,
  an existing Homebrew was discovered off `PATH` mid-attempt; a brew-free state, a fresh Homebrew
  prefix, and Keychain isolation were not established by retained evidence.
- The install mutated the shared Homebrew: it upgraded Node and dependencies and overwrote a
  pre-existing `llmux` executable (brew reported taking a backup). Do not claim the host was left
  untouched.
- Captured versions: `llmux` 0.2.20, `slack-cli` 4.6.0, controller/runtime formula
  `1.0.0.32971112778`, package version `1.0.0`, source `e96cd74f5b05121662237cd445ce34ac03ddab1d`.
- Release: <https://github.com/2lab-ai/soma-work/releases/tag/somawork-preview-v1.0.0-32971112778>.
- xbrew CI/release runs: <https://github.com/2lab-ai/xbrew/actions/runs/33004558425> and
  <https://github.com/2lab-ai/xbrew/actions/runs/33004637204>.
- Slack CLI read-only commands initialized an empty `{}` credential store; the read-only commands
  themselves were not removed, but the empty store was inspected token-free and then removed
  before setup — no Slack auth was captured in this attempt.
- Historical xbrew test suite: 73 passed. Not rerun in this session.

## What was NOT verified — no success evidence

- Install happened once (see above); Claude OAuth was attempted multiple times with no success —
  first attempt timed out, a later browser-automation attempt lost tab context with the approve
  control disabled. Root cause unknown.
- A `find` tool `429` observed during those OAuth attempts is **not** evidence the OAuth endpoint
  rejected auth or hit an account quota — no causal claim can be made from it.
- No Codex OAuth attempt.
- No Slack auth/token capture.
- No final onboarding profile.
- No doctor run, live service check, restart persistence check, or real Slack reply.
- No final sanitized HTML receipt.
- No verification of package fleet rollout. The current fleet path
  (`.github/workflows/deploy.yml:206-220`, `sync-bundle.sh` → `install-target.sh` → service status)
  is the legacy fleet deploy, not a package-formula rollout — do not conflate the two.
- No full clean-user end-to-end success.

## Evidence gap (as of 2026-09-11)

The prior test mount that held the closest historical install/receipt evidence was checked and
found absent. Cause (unmounted vs. deleted) is unknown; primary logs from that attempt are not
currently recovered.

## Documentation correction in this change

The clean-machine plan's Task 5 referenced `xbrew upgrade somawork-preview`. xbrew has no `upgrade`
subcommand. The released command is `xbrew update somawork-preview` (interactive y/n/all prompt),
or a direct `brew upgrade <formula>` on the formula as an alternative path — whether that
alternative can run non-interactively with rollback automation is still to be verified, not
assumed. Verified against commit-pinned xbrew source:
<https://github.com/2lab-ai/xbrew/blob/629b1c009b493570ccc81730a8401ebe757aa99a/src/main.rs#L52-L53>
(`Update` subcommand definition) and same file `#L73` (`Cmd::Update` dispatch to `resolve::update`).
Corrected in the plan in this change.

## Resume sequence (next attempt)

1. Recover the missing evidence volume, or start a new safe isolated context.
2. Re-pin the *current* public preview version — the 2026-08-26 tag is historical, not a claim
   about the latest release.
3. Establish a genuinely no-brew, real-installer receipt separately; mock/unit tests do not
   substitute for it.
4. Fresh Claude + Codex OAuth through `somawork setup`.
5. Slack auto token capture — no manual paste.
6. Doctor all-green, service restart persistence, one real Slack response.
7. Isolated adversarial/coexistence checks — mock production capture only; do not activate a real
   production Slack app.
8. Sanitized, durable HTML receipt.
9. Only then: preview package rollout with per-target verification and rollback.

Production/stable release remains user-gated throughout this sequence; nothing here weakens that
gate or the original acceptance spec.
