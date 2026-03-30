# Main Deploy Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the current `dev` deployment intact while making `main` deploy safely to `/opt/soma-work/main` with one-time legacy bootstrap on macmini.

**Architecture:** Add a tested bootstrap module that runs only for `main` deployments, copies seed config/runtime files from known macmini paths, normalizes legacy data with current compatibility logic, and then falls back to the existing rsync + `service.sh install` deploy path. Update setup scripts/docs so all operator-facing branch references align to `dev`.

**Tech Stack:** GitHub Actions, TypeScript, Vitest, bash setup scripts, macOS LaunchAgents

### Task 1: Lock the required behavior with failing tests

**Files:**
- Create: `src/deploy/main-env-bootstrap.test.ts`
- Create: `src/deploy/deploy-config.test.ts`

**Step 1: Write the failing tests**

- Add bootstrap tests for:
  - first-run copy from `/opt/soma-work/dev` + legacy root into an empty target
  - marker-based skip on rerun
  - refusal to overwrite a non-empty target without a marker
  - normalization of legacy `user-settings.json` and `sessions.json`
- Add deploy config tests for:
  - `main` workflow targeting `/opt/soma-work/main`
  - supporting setup scripts/docs referencing `dev`, not `develop`

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- src/deploy/main-env-bootstrap.test.ts src/deploy/deploy-config.test.ts
```

Expected: missing module/assertion failures for bootstrap behavior and stale `develop` references.

### Task 2: Implement main bootstrap module and workflow hook

**Files:**
- Create: `src/deploy/main-env-bootstrap.ts`
- Modify: `.github/workflows/deploy.yml`

**Step 1: Write minimal implementation**

- Export a bootstrap function and CLI entry that:
  - validates dev/legacy source paths
  - copies seed config files
  - copies legacy `.env` and `data/`
  - normalizes copied runtime data
  - writes `.main-bootstrap.json`
  - skips cleanly when the marker already exists
- Call the CLI from the `main` deploy path before rsync/install.

**Step 2: Run targeted tests**

Run:

```bash
npm test -- src/deploy/main-env-bootstrap.test.ts src/deploy/deploy-config.test.ts
```

Expected: bootstrap tests pass; config tests still fail until setup/docs are aligned.

### Task 3: Align setup scripts and docs to the live branch names

**Files:**
- Modify: `scripts/setup/05-system-prompt.sh`
- Modify: `scripts/setup/07-deploy-dirs.sh`
- Modify: `scripts/setup/09-github-environments.sh`
- Modify: `scripts/new-deploy-setup.sh`
- Modify: `docs/add-new-deploy.md`

**Step 1: Make the smallest possible text/script changes**

- Replace stale `develop` defaults with `dev`
- Document the first-time main bootstrap source paths and marker behavior

**Step 2: Re-run targeted tests**

Run:

```bash
npm test -- src/deploy/main-env-bootstrap.test.ts src/deploy/deploy-config.test.ts
```

Expected: all targeted tests pass.

### Task 4: Verify the branch is releasable

**Files:**
- Verify only

**Step 1: Run verification**

Run:

```bash
npm run lint
npm run build
npm test -- src/deploy/main-env-bootstrap.test.ts src/deploy/deploy-config.test.ts
```

Expected: no TypeScript errors, build succeeds, targeted tests pass.

**Step 2: Prepare PR summary**

- Summarize:
  - what changed in workflow/bootstrap
  - what changed in setup/docs
  - which tests prove it
