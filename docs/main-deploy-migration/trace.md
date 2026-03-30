# Main Deploy Migration — Vertical Trace

> STV Trace | Created: 2026-03-12
> Spec: docs/main-deploy-migration/spec.md

## Table of Contents

1. [Scenario 1 — First main deploy bootstraps runtime from dev and legacy roots](#scenario-1--first-main-deploy-bootstraps-runtime-from-dev-and-legacy-roots)
2. [Scenario 2 — Later main deploys skip bootstrap and only refresh code](#scenario-2--later-main-deploys-skip-bootstrap-and-only-refresh-code)
3. [Scenario 3 — Setup scripts and docs resolve to the dev branch consistently](#scenario-3--setup-scripts-and-docs-resolve-to-the-dev-branch-consistently)

## Scenario 1 — First main deploy bootstraps runtime from dev and legacy roots

### 1. API Entry

- Trigger: GitHub Actions `deploy` job for `github.ref_name == "main"`
- File: `.github/workflows/deploy.yml`
- Auth/AuthZ: Executes on the self-hosted macmini runner with filesystem access to `/opt/soma-work` and `/Users/dd/app.claude-code-slack-bot`

### 2. Input

- Required inputs:
  ```json
  {
    "ENV": "main",
    "TARGET": "/opt/soma-work/main",
    "DEV_SOURCE": "/opt/soma-work/dev",
    "LEGACY_ROOT": "/Users/dd/app.claude-code-slack-bot"
  }
  ```
- Validation rules:
  - `TARGET` must be an absolute path
  - `DEV_SOURCE` must exist and contain seed config files
  - `LEGACY_ROOT/.env` must exist
  - `LEGACY_ROOT/data` must exist
  - `TARGET` must be missing/empty, or already contain a bootstrap marker

### 3. Layer Flow

#### 3a. Workflow Step

- Transformation rules:
  - `github.ref_name=main` → `matrix.deploy_env=main`
  - `matrix.deploy_env=main` → bootstrap CLI executes before rsync/install
  - `matrix.target_dir=/opt/soma-work/main` → CLI target path

#### 3b. Bootstrap Module

- File: `src/deploy/main-env-bootstrap.ts`
- Transformation rules:
  - `DEV_SOURCE/.system.prompt` → `TARGET/.system.prompt`
  - `DEV_SOURCE/config.json` → `TARGET/config.json`
  - `DEV_SOURCE/mcp-servers.json` → `TARGET/mcp-servers.json`
  - `LEGACY_ROOT/.env` → `TARGET/.env`
  - `LEGACY_ROOT/data/**` → `TARGET/data/**`
  - `TARGET` → `process.env.SOMA_CONFIG_DIR` → runtime normalization loaders
- Domain decisions:
  - If marker exists, skip copy/migrate and return success
  - If target is non-empty without marker, fail to avoid clobbering unknown runtime state
  - After copy, load+save user settings and sessions through current compatibility logic

#### 3c. Repository / Filesystem

- Transaction boundary: one bootstrap execution on the runner before service restart
- Persisted files:
  - `TARGET/.main-bootstrap.json`
  - `TARGET/.env`
  - `TARGET/config.json`
  - `TARGET/mcp-servers.json`
  - `TARGET/.system.prompt`
  - `TARGET/data/user-settings.json`
  - `TARGET/data/sessions.json`

### 4. Side Effects

- CREATE: `/opt/soma-work/main/`
- CREATE: `/opt/soma-work/main/logs/`
- CREATE: `/opt/soma-work/main/data/`
- COPY: seed config files from `/opt/soma-work/dev`
- COPY: legacy `.env` and `data/` from `/Users/dd/app.claude-code-slack-bot`
- NORMALIZE: migrated `user-settings.json` and `sessions.json`
- WRITE: bootstrap marker with source metadata + timestamp

### 5. Error Paths

| Condition | Error | Status |
|-----------|-------|--------|
| `/opt/soma-work/dev` missing | bootstrap aborts before deploy | workflow failure |
| legacy `.env` missing | bootstrap aborts before deploy | workflow failure |
| legacy `data/` missing | bootstrap aborts before deploy | workflow failure |
| target contains files but no marker | bootstrap aborts to avoid overwrite | workflow failure |
| normalization throws | bootstrap aborts before service restart | workflow failure |

### 6. Output

- Success result:
  ```json
  {
    "bootstrapped": true,
    "targetDir": "/opt/soma-work/main",
    "markerFile": "/opt/soma-work/main/.main-bootstrap.json"
  }
  ```

### 7. Observability Hooks

- Workflow logs:
  - `bootstrap: start`
  - `bootstrap: copied seed config`
  - `bootstrap: copied legacy env/data`
  - `bootstrap: normalized runtime data`
  - `bootstrap: complete` or `bootstrap: skipped`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `bootstraps_main_target_from_dev_and_legacy_sources` | Happy Path | Scenario 1, Section 3 |
| `fails_when_target_is_non_empty_without_marker` | Sad Path | Scenario 1, Section 5 |
| `normalizes_legacy_user_settings_and_sessions_after_copy` | Contract | Scenario 1, Section 3b |

## Scenario 2 — Later main deploys skip bootstrap and only refresh code

### 1. API Entry

- Trigger: GitHub Actions `deploy` job for `main` after bootstrap marker exists
- File: `.github/workflows/deploy.yml`
- Auth/AuthZ: same self-hosted runner execution context

### 2. Input

- Required inputs:
  ```json
  {
    "ENV": "main",
    "TARGET": "/opt/soma-work/main",
    "MARKER": "/opt/soma-work/main/.main-bootstrap.json"
  }
  ```
- Validation rules:
  - Marker presence indicates bootstrap completed previously

### 3. Layer Flow

#### 3a. Workflow Step

- Transformation rules:
  - `ENV=main` + marker exists → bootstrap returns skipped
  - extracted `dist/`, `node_modules/`, `package.json`, `service.sh` → rsync to `TARGET`

#### 3b. Deploy Step

- Existing flow remains:
  - `TARGET/dist/` refreshed from artifact
  - `TARGET/node_modules/` refreshed from artifact
  - `service.sh main install` regenerates/restarts LaunchAgent

#### 3c. Repository / Filesystem

- Preserved files:
  - `TARGET/.env`
  - `TARGET/.system.prompt`
  - `TARGET/mcp-servers.json`
  - `TARGET/config.json`
  - `TARGET/data/**`
  - `TARGET/logs/**`

### 4. Side Effects

- UPDATE: code bundle files only
- RESTART: `ai.2lab.soma-work.main`
- NO-CHANGE: migrated runtime config/data

### 5. Error Paths

| Condition | Error | Status |
|-----------|-------|--------|
| bootstrap marker unreadable | deploy aborts | workflow failure |
| `service.sh main install` fails | main service not restarted | workflow failure |

### 6. Output

- Success status: workflow complete, service status reports running

### 7. Observability Hooks

- Workflow logs:
  - `bootstrap: skipped`
  - `Deploying mac-mini-main to /opt/soma-work/main`
  - `service status`

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `skips_bootstrap_when_marker_exists` | Happy Path | Scenario 2, Section 3 |
| `deploy_workflow_keeps_main_runtime_files_excluded_from_rsync` | Side-Effect | Scenario 2, Section 3c |

## Scenario 3 — Setup scripts and docs resolve to the dev branch consistently

### 1. API Entry

- Trigger: operator runs setup scripts or follows deploy documentation
- Files: `scripts/setup/05-system-prompt.sh`, `scripts/setup/07-deploy-dirs.sh`, `scripts/setup/09-github-environments.sh`, `scripts/new-deploy-setup.sh`, `docs/add-new-deploy.md`
- Auth/AuthZ: local operator execution / documentation consumption

### 2. Input

- Required inputs:
  ```json
  {
    "repo_branch_name": "dev"
  }
  ```
- Validation rules:
  - No setup script or deploy doc should instruct operators to use `develop`

### 3. Layer Flow

#### 3a. Setup Scripts

- Transformation rules:
  - `env=dev` → `branch=dev`
  - GitHub environment `development` → branch policy `dev`
  - Default PR target prompt → `dev`

#### 3b. Documentation

- Transformation rules:
  - deploy examples referencing development branch → `dev`
  - first-time main bootstrap doc → legacy root + bootstrap expectations

#### 3c. Filesystem / Config

- No runtime data changes
- Operator-facing text stays aligned with live branch names

### 4. Side Effects

- UPDATE: setup prompts/defaults
- UPDATE: deployment guide text

### 5. Error Paths

| Condition | Error | Status |
|-----------|-------|--------|
| stale `develop` reference remains | operator follows wrong branch | configuration drift |

### 6. Output

- Success state: scripts/docs consistently reference `dev`

### 7. Observability Hooks

- Test coverage reads script/doc contents directly for expected branch tokens

### Contract Tests (RED)

| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `deploy_supporting_scripts_reference_dev_branch` | Contract | Scenario 3, Section 3a |
| `deploy_workflow_routes_main_to_opt_soma_work_main` | Contract | Scenario 3, Section 3b |

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Treat the GitHub Actions workflow trigger as the trace entry point | tiny | This feature is deployment automation, not an HTTP endpoint |
| Use a filesystem marker rather than a GitHub environment flag for bootstrap completion | small | Runner-local state matches the asset that actually needs protecting |

## Implementation Status

| Scenario | Trace | Tests | Status |
|----------|-------|-------|--------|
| 1. First main deploy bootstraps runtime from dev and legacy roots | done | GREEN | Implemented |
| 2. Later main deploys skip bootstrap and only refresh code | done | GREEN | Implemented |
| 3. Setup scripts and docs resolve to the dev branch consistently | done | GREEN | Implemented |

## Next Step

→ Proceed with PR review / merge validation for PR `#38`
