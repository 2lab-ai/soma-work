# Project Gardening — Trace

> STV Trace | Created: 2026-03-26
> Spec: [spec.md](./spec.md)

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | Delete orphaned root files | tiny | 🟢 Done |
| 2 | Delete stale bun.lock | tiny | 🟢 Done |
| 3 | Remove incomplete slack-app-manifest.yaml | tiny | 🟢 Done |
| 4 | Archive completed feature docs | small | 🟢 Done |
| 5 | Archive debugging traces | small | 🟢 Done |
| 6 | Archive outdated plans | small | 🟢 Done |
| 7 | Clean up empty dirs after moves | tiny | 🟢 Done |
| 8 | Rewrite README.md | medium | 🟢 Done |
| 9 | Update README.ko.md | medium | 🟢 Done |
| 10 | Verify no broken references | small | 🟢 Done |

---

## Scenario 1: Delete orphaned root files

**Files to delete:**
- `dotnet-install.sh` — 63KB .NET installer, unreferenced
- `test-token-refresh.js` — Test utility, unreferenced
- `ask_user_question_example.json` — Example JSON, unreferenced

**Verification:** `git status` shows 3 deleted files, no broken imports/references.

---

## Scenario 2: Delete stale bun.lock

**Action:** `git rm bun.lock`

**Verification:** CI uses `npm ci` with `package-lock.json`. No bun references remain.

---

## Scenario 3: Remove incomplete slack-app-manifest.yaml

**Action:** `git rm slack-app-manifest.yaml`

**Verification:** README updated to reference only `slack-app-manifest.json`.

---

## Scenario 4: Archive completed feature docs

**Move 8 directories to `docs/archive/features/`:**
```
docs/admin-commands/         → docs/archive/features/admin-commands/
docs/docs-cleanup/           → docs/archive/features/docs-cleanup/
docs/mcp-session-tick/       → docs/archive/features/mcp-session-tick/
docs/mid-thread-initial-response/ → docs/archive/features/mid-thread-initial-response/
docs/rich-turn-notification/ → docs/archive/features/rich-turn-notification/
docs/session-workspace-isolation/ → docs/archive/features/session-workspace-isolation/
docs/slash-commands/         → docs/archive/features/slash-commands/
docs/turn-notification/      → docs/archive/features/turn-notification/
```

**Verification:** Directories exist in archive, originals removed.

---

## Scenario 5: Archive debugging traces

**Move 7 directories to `docs/archive/debugging/`:**
```
docs/debugging/ask-user-q-duplicate-20260326/
docs/debugging/auto-resume-partial-failure-202603261550/
docs/debugging/image-error-mcp-path-20260326/
docs/debugging/image-processing-error-20260326/
docs/debugging/issue64-202603250015/
docs/debugging/token-rotation-race-20260326/
docs/debugging/uiask-buttons-remain-202603240912/
```

**Verification:** All debugging traces in archive, docs/debugging/ removed if empty.

---

## Scenario 6: Archive outdated plans

**Move 6 files to `docs/archive/plans/`:**
```
docs/plans/2026-02-06-slack-ui-routing-panel-fix-design.md
docs/plans/2026-02-23-model-thread-header-bug-fix.md
docs/plans/2026-02-25-thinking-steps-streaming-refactoring.md
docs/plans/2026-02-26-compact-tool-params-design.md
docs/plans/2026-03-12-main-deploy-migration.md
docs/plans/2026-03-12-main-only-deploy-workflow.md
```

**Verification:** Plans in archive, docs/plans/ removed if empty.

---

## Scenario 7: Clean up empty dirs after moves

**Remove empty directories:** `docs/debugging/`, `docs/plans/` if empty after moves.

---

## Scenario 8: Rewrite README.md

**Professional README with:**
- Hero section with project name, description, badges (CI, License, Node version)
- Quick visual demo (command examples)
- Accurate architecture diagram with current LOC counts
- Feature highlights with icons
- Updated stats: 167 source files, 97 tests, ~36k source LOC, ~22k test LOC
- Clean command reference table
- Quick start guide
- Deployment options
- GitHub integration guide
- Troubleshooting
- Contributing section

**Verification:** All stats match actual codebase. No stale numbers.

---

## Scenario 9: Update README.ko.md

**Mirror English README structure and content in Korean.**

**Verification:** Structure matches README.md, Korean text is natural.

---

## Scenario 10: Verify no broken references

**Check:**
- Dockerfile still references `setup-git-auth.sh` and `healthcheck.js` at root ✓
- Makefile still references `service.sh` ✓
- CI workflow unchanged ✓
- No source code references deleted files ✓
- README references `slack-app-manifest.json` only (not .yaml) ✓

**Verification:** `grep -r` for all deleted/moved file names in source code returns no hits.
