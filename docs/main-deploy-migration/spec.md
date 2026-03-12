# Main Deploy Migration — Spec

> STV Spec | Created: 2026-03-12

## 1. Overview

현재 macmini 배포는 `dev` 브랜치 기준 `/opt/soma-work/dev` 환경을 중심으로 운영된다. 이 변경은 기존 `dev` 배포를 그대로 유지하면서, `main` 브랜치도 동일한 macmini에 `/opt/soma-work/main`으로 독립 배포되도록 만든다.

첫 `main` 배포는 빈 디렉토리에 코드만 rsync 하는 것으로는 충분하지 않다. `main` 환경은 `/opt/soma-work/dev`의 설정 구조를 seed로 사용하고, legacy 운영 경로인 `/Users/dd/app.claude-code-slack-bot`에서 `.env`와 `data/`를 가져와 현재 런타임이 읽을 수 있는 형태로 정규화해야 한다.

## 2. User Stories

- As a maintainer, I want `main` pushes to deploy to `/opt/soma-work/main` on macmini, so that production and development run independently.
- As an operator, I want the first `main` deployment to bootstrap config and legacy runtime data automatically, so that I do not have to manually rebuild the environment over SSH each time.
- As a maintainer, I want setup scripts and docs to use the current `dev` branch naming consistently, so that operators do not accidentally target the obsolete `develop` branch.

## 3. Acceptance Criteria

- [ ] Existing `dev` deployment behavior remains unchanged for `/opt/soma-work/dev`.
- [ ] `main` branch pushes deploy to macmini `/opt/soma-work/main` and restart `ai.2lab.soma-work.main`.
- [ ] On the first `main` deployment, the runner seeds `/opt/soma-work/main` from `/opt/soma-work/dev` structure, copies legacy `.env` from `/Users/dd/app.claude-code-slack-bot/.env`, and copies legacy data from `/Users/dd/app.claude-code-slack-bot/data`.
- [ ] Legacy bootstrap is idempotent: once completed, later `main` deploys do not overwrite runtime config/data.
- [ ] Legacy data is normalized through current migration logic for user settings and session persistence before the service is restarted.
- [ ] Setup scripts and operator docs reference `dev` rather than `develop` for branch policies and checkout defaults.
- [ ] The workflow change is covered by automated tests for bootstrap behavior and deploy config expectations.

## 4. Scope

### In-Scope

- `.github/workflows/deploy.yml` main-branch bootstrap and deploy sequencing
- New deploy bootstrap/migration module for macmini main environment
- Setup scripts that still point at `develop`
- Operator documentation for first-time `main` bootstrap on macmini
- Automated tests for bootstrap idempotence and branch naming expectations

### Out-of-Scope

- Changing Slack app/token provisioning beyond copying existing config
- Reworking `dev` multi-runner topology
- General-purpose migration tooling for arbitrary legacy roots
- Replacing the current LaunchAgent/service model

## 5. Architecture

### 5.1 Layer Structure

1. GitHub Actions `deploy.yml` continues to build once and fan out deploy targets by branch.
2. The `main` deploy path calls a bootstrap module on the self-hosted runner before rsync/install.
3. The bootstrap module validates source paths, copies seed config/runtime files, then invokes current migration-aware loaders against the target config directory.
4. Existing `service.sh` install flow remains responsible for LaunchAgent regeneration and restart.

### 5.2 Execution Entry Points

| Trigger | File | Entry | Description |
|--------|------|-------|-------------|
| `push` to `main` | `.github/workflows/deploy.yml` | deploy job | Bootstrap `/opt/soma-work/main` if needed, then deploy bundle and restart service |
| `push` to `dev` | `.github/workflows/deploy.yml` | deploy job | Keep current `/opt/soma-work/dev` deploy behavior |
| Runner-local bootstrap | `src/deploy/main-env-bootstrap.ts` | CLI/main module | Seed config structure, copy legacy `.env`/`data`, run normalization, write marker |
| Operator setup | `scripts/setup/*`, `scripts/new-deploy-setup.sh`, `docs/add-new-deploy.md` | interactive/manual setup | Ensure branch defaults and docs match `dev` naming |

### 5.3 Data / Filesystem Schema

- Target runtime root: `/opt/soma-work/main`
- Seed config source: `/opt/soma-work/dev`
- Legacy source root: `/Users/dd/app.claude-code-slack-bot`
- Required copied files:
  - `/opt/soma-work/dev/.system.prompt` → `/opt/soma-work/main/.system.prompt`
  - `/opt/soma-work/dev/config.json` → `/opt/soma-work/main/config.json`
  - `/opt/soma-work/dev/mcp-servers.json` → `/opt/soma-work/main/mcp-servers.json`
  - `/Users/dd/app.claude-code-slack-bot/.env` → `/opt/soma-work/main/.env`
  - `/Users/dd/app.claude-code-slack-bot/data/**` → `/opt/soma-work/main/data/**`
- Bootstrap marker file:
  - `/opt/soma-work/main/.main-bootstrap.json`

### 5.4 Integration Points

- `src/env-paths.ts` + `SOMA_CONFIG_DIR` determine runtime config/data lookup under `/opt/soma-work/main`
- `src/user-settings-store.ts` applies legacy user-settings migrations on load/save
- `src/session-registry.ts` applies legacy session fallbacks on load/save
- `service.sh` restarts the correct environment-specific LaunchAgent after deploy

## 6. Non-Functional Requirements

- Reliability: bootstrap must fail fast when required legacy paths are missing, before code rsync or service restart.
- Safety: bootstrap must not overwrite an already-initialized `main` environment unless explicitly re-run through marker removal.
- Operability: workflow logs must show whether bootstrap ran, skipped, or failed.
- Maintainability: branch naming in scripts/docs must match the actual repo branch (`dev`) to avoid operator confusion.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Use a marker file in `/opt/soma-work/main` to guard one-time bootstrap | small | Keeps reruns idempotent without changing the existing deploy topology |
| Seed only config/runtime structure from `dev`, not `dist/` or `node_modules/` | small | Deploy workflow already owns code artifact sync; bootstrap should only prepare preserved files |
| Reuse current migration-aware loaders for `user-settings.json` and `sessions.json` normalization | small | Existing code already contains the legacy compatibility rules the user wants preserved |
| Fix `develop` references in setup scripts/docs as part of the same change | small | The branch rename mismatch directly impacts the requested deploy path and operator workflow |

## 8. Open Questions

None.

## 9. Next Step

→ Proceed with Vertical Trace via `docs/main-deploy-migration/trace.md`
