# Project Gardening — Spec

> STV Spec | Created: 2026-03-26

## 1. Overview

soma-work repository has accumulated root-level clutter, outdated documentation, and a README with stale statistics. This gardening pass removes unused files, archives completed/stale docs, and rewrites the README to reflect the project's current state with a professional, visually appealing design.

## 2. User Stories

- As a new contributor, I want a clean root directory so I can quickly understand the project structure
- As a developer, I want accurate README stats so I can trust the documentation
- As a new contributor, I want a professional README so I can evaluate the project quickly
- As a maintainer, I want archived docs separated from active ones so I can find relevant specs efficiently

## 3. Acceptance Criteria

- [ ] Root directory contains zero orphaned/unused files
- [ ] Only one lock file (package-lock.json) remains
- [ ] Completed feature docs (8) are archived under docs/archive/features/
- [ ] Debugging traces (7) are archived under docs/archive/debugging/
- [ ] Outdated plans (6) are archived under docs/archive/plans/
- [ ] README.md reflects accurate file counts and LOC (167 source files, 97 test files, ~36k source LOC, ~22k test LOC)
- [ ] README.md has professional visual design with badges, clear sections, and accurate architecture diagram
- [ ] README.ko.md is updated to match or removed if redundant
- [ ] No Dockerfile, Makefile, or CI references are broken

## 4. Scope

### In-Scope
- Delete orphaned root files (dotnet-install.sh, test-token-refresh.js, ask_user_question_example.json)
- Delete stale bun.lock
- Archive completed feature docs, debugging traces, outdated plans
- Rewrite README.md with accurate stats and professional design
- Update README.ko.md to match
- Remove incomplete slack-app-manifest.yaml (keep canonical JSON)

### Out-of-Scope
- Moving service.sh, setup-git-auth.sh, healthcheck.js (Dockerfile/Makefile dependencies)
- Refactoring source code
- Updating CLAUDE.md or AGENTS.md
- Changing CI/CD workflows

## 5. Architecture

### 5.1 Changes Overview

This is a file-level reorganization, not a code change. No runtime behavior is affected.

```
DELETE:
  ./dotnet-install.sh          (63KB, unreferenced .NET installer)
  ./test-token-refresh.js      (unreferenced test script)
  ./ask_user_question_example.json  (unreferenced example)
  ./bun.lock                   (stale, project uses npm)
  ./slack-app-manifest.yaml    (incomplete, JSON is canonical)

MOVE → docs/archive/features/:
  docs/admin-commands/
  docs/docs-cleanup/
  docs/mcp-session-tick/
  docs/mid-thread-initial-response/
  docs/rich-turn-notification/
  docs/session-workspace-isolation/
  docs/slash-commands/
  docs/turn-notification/

MOVE → docs/archive/debugging/:
  docs/debugging/ask-user-q-duplicate-20260326/
  docs/debugging/auto-resume-partial-failure-202603261550/
  docs/debugging/image-error-mcp-path-20260326/
  docs/debugging/image-processing-error-20260326/
  docs/debugging/issue64-202603250015/
  docs/debugging/token-rotation-race-20260326/
  docs/debugging/uiask-buttons-remain-202603240912/

MOVE → docs/archive/plans/:
  docs/plans/2026-02-06-slack-ui-routing-panel-fix-design.md
  docs/plans/2026-02-23-model-thread-header-bug-fix.md
  docs/plans/2026-02-25-thinking-steps-streaming-refactoring.md
  docs/plans/2026-02-26-compact-tool-params-design.md
  docs/plans/2026-03-12-main-deploy-migration.md
  docs/plans/2026-03-12-main-only-deploy-workflow.md

REWRITE:
  ./README.md    (professional design, accurate stats)
  ./README.ko.md (sync with English version)
```

### 5.2 API Endpoints
N/A — no runtime changes.

### 5.3 DB Schema
N/A — no data changes.

### 5.4 Integration Points
- Dockerfile references `setup-git-auth.sh` and `healthcheck.js` at root → NOT touched
- Makefile references `service.sh` → NOT touched
- CI workflow uses `npm ci` → compatible with bun.lock removal
- README references `slack-app-manifest.json` (or `.yaml`) → update to reference JSON only

## 6. Non-Functional Requirements

- Performance: N/A
- Security: Ensure no .env or credential files are accidentally committed
- Scalability: Archive structure should scale as more features are completed

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Delete dotnet-install.sh | tiny | 63KB .NET script unreferenced in TypeScript project. Restorable via git. |
| Delete test-token-refresh.js | tiny | Root-level test utility, unreferenced anywhere. |
| Delete ask_user_question_example.json | tiny | Example JSON, unreferenced. |
| Delete bun.lock | tiny | Project uses npm exclusively (CI, Dockerfile, package.json). |
| Remove slack-app-manifest.yaml | small | YAML has only 11/18 scopes and 3/5 events vs JSON. Incomplete copy. README will reference JSON only. |
| Archive completed docs vs delete | small | Archive preserves history for reference while decluttering active docs/. |
| Archive structure: features/debugging/plans | tiny | Natural categorization matching existing content types. |
| Keep docs/debugging/ directory (empty after move) | tiny | Remove empty dir. Future debugging traces go to docs/archive/debugging/. |
| README style: badge-heavy professional design | small | User explicitly requested "이쁘고 프로페셔널하게". Single file, easily revised. |
| Update README.ko.md vs remove | small | Keep bilingual support. User base includes Korean speakers. Sync content. |

## 8. Open Questions

None — all decisions within autonomous judgment range.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace`
