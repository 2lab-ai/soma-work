# somawork Public Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish immutable public macOS ARM64 controller/runtime assets, installable as coexisting `somawork-cli`, `somawork`, and `somawork-preview` Homebrew formulae and resolvable through xbrew.

**Architecture:** soma-work builds signed-by-hash tar assets plus a machine-readable manifest. homebrew-tap renders three formulae from immutable release data. xbrew adds a general formula recipe backend and two recipes; it does not embed soma-work installation scripts.

**Tech Stack:** GitHub Actions/releases, tar/SHA-256, Ruby Formulae, Rust/serde/xbrew, shell contract tests.

**Spec:** `docs/superpowers/specs/2026-08-23-somawork-setup-onboarding-design.md` §4 and verification companion §1.3.

## Global Constraints

- Assets are public and immutable; no install-time GitHub credential.
- Formulae install no mutable profile state in Cellar.
- Stable and preview runtime formulae coexist; only controller links `bin/somawork`.
- Release manifest includes source SHA, version, channel, asset SHA/bytes, layout version, and minimum Node.
- Preview publish and tap bump are automatic; stable release remains explicit user-gated.

---

### Task 1: Build controller/runtime release assets

**Repo:** `2lab-ai/soma-work`

**Files:**
- Create: `scripts/release/package-somawork.sh`
- Create: `scripts/release/render-manifest.ts`
- Create: `scripts/__tests__/package-somawork.test.ts`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces `somawork-cli-<version>-darwin-arm64.tar.gz`, `somawork-<version>-darwin-arm64.tar.gz`, `somawork-preview-<version>-darwin-arm64.tar.gz`, `somawork-manifest.json`.

- [ ] Write RED tests that inspect tar listings: controller has only CLI/setup assets; runtimes have dist/workspace assets+production deps; no `.env`, config, data, logs, tests, source maps, or setup state.
- [ ] Implement deterministic packaging (`COPYFILE_DISABLE=1`, sorted tar, normalized timestamps) and SHA manifest generation.
- [ ] Run tests twice and assert byte-identical SHA for identical inputs.
- [ ] Add preview release publication after build/smoke; dispatch tap bump with immutable tag+manifest URL+SHA.
- [ ] Commit: `feat(release): publish somawork controller and runtime assets`.

### Task 2: Homebrew formula templates and contract tests

**Repo:** `2lab-ai/homebrew-tap`

**Files:**
- Create: `Formula/somawork-cli.rb.tmpl`
- Create: `Formula/somawork-preview.rb.tmpl`
- Create: `Formula/somawork.rb.tmpl`
- Create: `scripts/render-somawork-formulae.py`
- Create: `scripts/test-somawork-formulae.sh`
- Modify: `.github/workflows/bump.yml`

**Interfaces:**
- Controller formula links `somawork`, depends on Node and llmux; runtime formulae depend on controller and install payload under `libexec/runtime/{profile}` with no service block.

- [ ] Write RED shell/Ruby tests for URLs/SHA/version, dependency graph, no shared linked executable in runtimes, no service block, coexistence, and post-install message containing exact setup command.
- [ ] Implement templates and renderer driven only by manifest.
- [ ] Add idempotent bump workflow input for soma-work manifest; commit-before-rebase pattern.
- [ ] Run `ruby -c`, `brew audit --strict` where supported, renderer fixture tests, and formula install tests in a temporary tap.
- [ ] Commit: `feat(tap): add somawork stable and preview formulae`.

### Task 3: xbrew formula recipe backend

**Repo:** `2lab-ai/xbrew`

**Files:**
- Modify: `src/recipe.rs`
- Modify: `src/resolve.rs`
- Create: `recipes/somawork.toml`
- Create: `recipes/somawork-preview.toml`
- Create: `tests/somawork_recipe_contract.rs`

**Interfaces:**
- Add `MacSpec.formula: Option<String>`; macOS recipe precedence is cask→formula→dmg→script; installation record uses backend `brew`, kind `formula`.

- [ ] Write RED Rust tests for formula parsing, fully-qualified tap token, install/uninstall/version routing, and both recipe names.
- [ ] Implement generic formula backend without soma-work branches.
- [ ] Run `cargo fmt --check`, `cargo test`, and local fake-brew integration.
- [ ] Commit: `feat(recipes): support tapped formulae and somawork channels`.

### Task 4: Fresh-prefix coexistence receipt

**Repos:** soma-work, homebrew-tap, xbrew

- [ ] Create isolated `HOMEBREW_PREFIX`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `SOMAWORK_HOME`, and fake HOME; no existing brew receipt or source checkout may be visible.
- [ ] Install preview through built xbrew and assert controller/runtime paths and `somawork --version`.
- [ ] Install stable beside preview and assert both runtime roots remain while controller is single.
- [ ] Upgrade preview, uninstall preview, and verify production profile/runtime remains intact; then inverse.
- [ ] Save command transcript, formula receipts, manifests, SHAs, and filesystem tree for Workstream C.
- [ ] Commit only reusable test harnesses; receipt outputs stay in session scratchpad.
