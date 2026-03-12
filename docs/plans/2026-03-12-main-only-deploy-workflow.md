# Main-Only Deploy Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the old `dev` branch deployment model with a `main` development line and a `deploy/prod` production deployment line.

**Architecture:** Keep the existing two deployment directories and services (`/opt/soma-work/dev` and `/opt/soma-work/main`), but decouple them from branch names. `main` becomes the source branch for dev deployments on both dev runners, while `deploy/prod` becomes the source branch for production deployments on macmini. Update setup defaults, environment policies, and operator docs to match.

**Tech Stack:** GitHub Actions, shell setup scripts, Markdown operator docs, Vitest config tests

### Task 1: Lock the new workflow in tests

**Files:**
- Modify: `src/deploy/deploy-config.test.ts`

**Step 1: Write the failing test**

- Assert `.github/workflows/deploy.yml` triggers on `main` and `deploy/prod`
- Assert `main` branch deploys to `/opt/soma-work/dev` on both dev runners
- Assert `deploy/prod` deploys to `/opt/soma-work/main` on macmini
- Assert setup/docs defaults use `main` as the PR target and `deploy/prod` as the production branch policy

**Step 2: Run test to verify it fails**

Run: `npm test -- src/deploy/deploy-config.test.ts`
Expected: FAIL because current workflow still depends on `dev`

### Task 2: Rewire workflow and setup defaults

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/version-bump.sh`
- Modify: `scripts/setup/05-system-prompt.sh`
- Modify: `scripts/setup/07-deploy-dirs.sh`
- Modify: `scripts/setup/09-github-environments.sh`
- Modify: `scripts/new-deploy-setup.sh`

**Step 1: Update branch-to-environment mapping**

- `main` push triggers dev deployment matrix on macmini + oudwood-512 into `/opt/soma-work/dev`
- `deploy/prod` push triggers production deployment on macmini into `/opt/soma-work/main`

**Step 2: Update release/version track logic**

- Make `scripts/version-bump.sh` treat `main` as the dev tag track
- Make `scripts/version-bump.sh` treat `deploy/prod` as the production tag track
- Preserve the actual git ref in `dist/version.json`

**Step 3: Update setup defaults**

- Default PR target becomes `main`
- `/opt/soma-work/dev` setup checks out `main`
- `/opt/soma-work/main` setup checks out `deploy/prod`
- GitHub Environment policies become `main -> development`, `deploy/prod -> production`

### Task 3: Update operator docs

**Files:**
- Modify: `docs/add-new-deploy.md`

**Step 1: Update workflow examples and branch descriptions**

- Replace old `dev` deployment examples with `main`
- Replace production branch examples with `deploy/prod`
- Keep directory semantics (`dev` dir vs `main` dir) clear

### Task 4: Verify and clean up obsolete branch

**Files:**
- None

**Step 1: Run verification**

Run:
- `npm test -- src/deploy/deploy-config.test.ts`
- `npm run lint`
- `npm test`

Expected: PASS

**Step 2: Remove obsolete branch**

Run:
- `git branch -d dev`
- `git push origin --delete dev`

Expected: local and remote `dev` branch removed
