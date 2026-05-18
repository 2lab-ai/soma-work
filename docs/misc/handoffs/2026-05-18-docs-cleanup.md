# Docs Cleanup Handoff

Date: 2026-05-18
Branch: `zhuge/docs-agent-research`
Worktree: `/Users/zhugehyuk/2lab.ai/soma-work/.worktree/docs-agent-research`

## Current State

This handoff exists because the previous pass did not actually clean the root and `docs/` tree enough. It added a documentation map and indexes, but it did not reduce the visible clutter in `docs/`.

Current uncommitted changes in this worktree:

- Modified root entrypoints:
  - `README.md`
  - `README.ko.md`
  - `CLAUDE.md`
- Added documentation routing/index files:
  - `docs/README.md`
  - `docs/archive/completed-work.md`
  - `docs/adr/README.md`
  - `docs/adr/0001-documentation-system-of-record.md`
  - `docs/misc/research/2026-05-18-ai-agent-docs-organization.md`
  - `docs/misc/handoffs/2026-05-18-docs-cleanup.md`

Important: these changes are not enough to satisfy a "root/docs cleanup" request. Treat them as scaffolding for the real cleanup, not as final output.

## What Was Verified

Commands already run in the worktree:

- `git diff --check` passed.
- Local markdown link resolver passed for the newly edited/added docs.
- Trailing whitespace check passed for the edited/added docs.

Baseline project checks were not clean before documentation edits:

- `npm run lint` fails on existing Biome diagnostics in test/source files unrelated to this docs work.
- `npm test` fails on existing integration/webhook tests:
  - Claude credential slot missing in `claude-handler.integration.test.ts`.
  - `webhook-channel.test.ts` expectations fail because mocked fetch is not called.

Do not claim repo-wide test/lint success unless those baseline failures are addressed or scoped out.

## User Feedback To Address

The user objected that root and `docs/` are still messy. That is correct. The next pass should physically reduce and reorganize the docs surface, not just add indexes.

## Cleanup Move Manifest

Applied in the follow-up cleanup pass:

```text
source path | destination path | reason | evidence line
docs/slack-ui-phase0.md | docs/archive/features/slack-ui/phase0.md | historical Phase 0 harness for the completed Slack UI phase chain | docs/archive/features/slack-ui/phase1.md:4 says Phase 0 proved the runtime before Phase 1
docs/slack-ui-phase1.md | docs/archive/features/slack-ui/phase1.md | historical Phase 1 migration doc | docs/archive/features/slack-ui/phase1.md:17 marks B1 as migrated
docs/slack-ui-phase2.md | docs/archive/features/slack-ui/phase2.md | historical Phase 2 migration doc | docs/archive/features/slack-ui/phase2.md:17-18 mark B1/B2 absorbed/migrated
docs/slack-ui-phase3.md | docs/archive/features/slack-ui/phase3.md | historical Phase 3 migration doc | docs/archive/features/slack-ui/phase3.md:5-9 says Phase 2 PR #664 preceded Phase 3
docs/slack-ui-phase4.md | docs/archive/features/slack-ui/phase4.md | historical Phase 4 migration doc | docs/archive/features/slack-ui/phase5.md:4-8 says Phase 4 Part 2 PR #700 preceded Phase 5 completion
docs/slack-ui-phase5.md | docs/archive/features/slack-ui/phase5.md | historical final phase doc | docs/archive/features/slack-ui/phase5.md:6-8 says Phase 5 completes 5-block-per-turn convergence
docs/PLANS/617-compact-tracking-plan.md | docs/archive/plans/617-compact-tracking-plan.md | historical plan, not an active execution entrypoint | handoff recommendation listed it as likely archive/plans candidate after status review
docs/project-gardening/ | docs/archive/features/project-gardening/ | completed docs cleanup feature | docs/archive/features/project-gardening/trace.md:10-19 marks all scenarios Done
docs/ghost-session-fix/ | docs/archive/features/ghost-session-fix/ | completed feature trace | docs/archive/features/ghost-session-fix/trace.md:167-172 marks all scenarios Complete and verified
docs/issue64-midthread-fix-v2/ | docs/archive/features/issue64-midthread-fix-v2/ | completed feature trace | docs/archive/features/issue64-midthread-fix-v2/trace.md:288-309 marks all scenarios Complete and verified
docs/main-deploy-migration/ | docs/archive/features/main-deploy-migration/ | implemented feature trace | docs/archive/features/main-deploy-migration/trace.md:275-277 marks all scenarios Implemented
docs/media-file-support/ | docs/archive/features/media-file-support/ | completed feature trace | docs/archive/features/media-file-support/trace.md:228-245 marks all scenarios Complete and verified
docs/portrait-extractor/ | docs/archive/features/portrait-extractor/ | completed feature trace | docs/archive/features/portrait-extractor/trace.md:82-93 marks all scenarios Complete and verified
docs/slack-mcp-cross-thread/ | docs/archive/features/slack-mcp-cross-thread/ | completed feature trace | docs/archive/features/slack-mcp-cross-thread/trace.md:291-301 marks all scenarios Complete and verified
docs/user-profile-variables/ | docs/archive/features/user-profile-variables/ | completed feature trace | docs/archive/features/user-profile-variables/trace.md:5 and 246-249 mark implementation/tests complete
plan/MASTER-SPEC.md | docs/current/spec/z-command-master-spec.md | evergreen `/z` command master spec moved out of root-only plan directory | docs/README.md lists `docs/current/spec/` as evergreen product/system specs
docs/daily-weekly-report/ | docs/archive/features/daily-weekly-report/ | completed report feature trace | docs/archive/features/daily-weekly-report/trace.md:652-657 marks all six scenarios Complete
docs/pr-workflow-transition-command/ | docs/archive/features/pr-workflow-transition-command/ | completed PR workflow transition trace | docs/archive/features/pr-workflow-transition-command/trace.md:420-426 marks all scenarios Complete and records Verified At
docs/handoff-entrypoints/ | docs/archive/features/handoff-entrypoints/ | completed handoff entrypoint feature | docs/archive/features/handoff-entrypoints/trace.md:406 marks the enforcement row as 구현 완료 (#695)
docs/pr-issue-precondition/ | docs/archive/features/pr-issue-precondition/ | completed PR precondition guard feature | docs/archive/features/pr-issue-precondition/trace.md:340 marks the enforcement row as 구현 완료 (#696)
docs/handoff-budget/ | docs/archive/features/handoff-budget/ | completed handoff budget and recursion guard feature | docs/archive/features/handoff-budget/trace.md:556-557 marks both rows as 구현 완료 (#697)
docs/dispatch-safe-stop/ | docs/archive/features/dispatch-safe-stop/ | completed dispatch safe-stop feature | docs/archive/features/dispatch-safe-stop/trace.md:563 says the row flipped to 구현 완료 (#698)
docs/current/plans/a2t/ | docs/archive/features/a2t/ | implemented A2T service spec | docs/archive/features/a2t/spec.md:22-29 marks all acceptance criteria checked
docs/current/plans/cron-scheduler/ | docs/archive/features/cron-scheduler/ | implemented cron scheduler feature | docs/archive/features/cron-scheduler/spec.md:3 marks Status: Implemented and lines 20-31 check acceptance criteria
docs/current/plans/disallow-native-interactive-tools/ | docs/archive/features/disallow-native-interactive-tools/ | implemented Slack-context SDK tool blocking | docs/archive/features/disallow-native-interactive-tools/trace.md:7-10 marks all scenarios GREEN
docs/current/plans/fix-thread-header-files/ | docs/archive/features/fix-thread-header-files/ | implemented mid-thread root file visibility fix | docs/archive/features/fix-thread-header-files/trace.md:7-9 marks all scenarios GREEN
docs/current/plans/sdk-abort-crash-defense/ | docs/archive/features/sdk-abort-crash-defense/ | implemented SDK abort crash defense | docs/archive/features/sdk-abort-crash-defense/trace.md:7-10 marks all scenarios GREEN
docs/current/plans/sdk-abort-crash-guard/ | docs/archive/features/sdk-abort-crash-guard/ | implemented SDK abort crash guard | docs/archive/features/sdk-abort-crash-guard/trace.md:7-9 marks all scenarios GREEN
docs/current/plans/session-restore-pattern-fix/ | docs/archive/features/session-restore-pattern-fix/ | implemented session restore error pattern fix | docs/archive/features/session-restore-pattern-fix/trace.md:7-10 marks all scenarios GREEN
docs/current/plans/slack-api-helper-hotpath/ | docs/archive/features/slack-api-helper-hotpath/ | completed SlackApiHelper hot path integration | docs/archive/features/slack-api-helper-hotpath/trace.md:246-248 marks all scenarios Complete/GREEN
docs/current/plans/turn-summary-lifecycle/ | docs/archive/features/turn-summary-lifecycle/ | implemented turn summary lifecycle feature | docs/archive/features/turn-summary-lifecycle/spec.md:3 marks Status: Implemented and lines 23-32 check acceptance criteria
```

Second audit notes:

- `docs/current/plans/session-archive/` stayed current because its acceptance criteria are unchecked and its trace still says `Ready for stv:work`.
- `docs/current/plans/z-memory-ui-improve/` stayed current because the trace table still marks scenarios `RED`; the later integration checklist is not enough to prove the whole feature closed.
- `docs/stale-plans/review-needed/cct-redesign/` stayed under review-needed because the trace says only PR#1 is scoped and M1-S5/M2/M3 remain backlog.
- `docs/stale-plans/review-needed/dashboard-conversation/` stayed under review-needed because it is mixed `[LIVE]`, `[WIRED]`, `[PARTIAL]`, and `[PLANNED]`, not a clean completed-feature artifact.
- Rows that only say `done | RED | Ready for stv:work` were treated as trace-writing complete, not implementation complete.

## Root Retention Decisions

- `slack-app-manifest.prev.json` moved to `docs/archive/manifests/slack-app-manifest.prev.json`; `scripts/slack-manifest-rollback.sh` now reads the archived snapshot directly.
- `slack-app-manifest.pre-666.json` moved to `docs/archive/manifests/slack-app-manifest.pre-666.json`; archived Slack UI Phase 4 rollback instructions now reference the archived snapshot path.
- Runtime/setup files moved out of root: `scripts/service.sh`, `scripts/healthcheck.js`, `scripts/setup-git-auth.sh`, `scripts/setup-wizard-macos.sh`, `infra/docker/`, `infra/slack/`, and `infra/claude/`.

## Recommended Next Pass

### 1. Keep Root Minimal

Root should keep product/build/config entrypoints only. Do not add more top-level markdown unless it is one of:

- `README.md`
- `README.ko.md`
- `CLAUDE.md`
- `AGENTS.md`

Root cleanup notes:

- Historical Slack manifest snapshots are now under `docs/archive/manifests/`.
- Root runtime/setup scripts were moved after checking references; keep future operational entrypoints under `scripts/` or `infra/`, not repo root.
- Existing untracked files in the main checkout are not part of this worktree cleanup. Leave them alone unless the user explicitly asks.

### 2. Reduce `docs/` Top-Level Noise

Current `docs/` has many feature directories directly under it. The cleaner target should be:

- `docs/current/` or keep top-level only for evergreen docs.
- `docs/current/plans/` for active feature specs/traces.
- `docs/archive/features/` for completed/stale feature specs/traces.
- `docs/misc/debugging/current/` for current debug traces, with old ones in `docs/archive/debugging/`.
- `docs/misc/research/` for dated external research.
- `docs/adr/` for durable repo-wide decisions.
- `docs/misc/handoffs/` for handoff notes like this one.

Avoid moving a directory just because it looks old. Move only when one of these is true:

- `trace.md` has explicit `Done`, `Complete`, `Implemented`, or `구현 완료` evidence.
- The doc is already superseded by a newer trace/spec.
- The doc is a historical plan that should not be used as an active execution plan.

### 3. Build A Move Manifest Before Moving

Create a temporary manifest in the handoff or a new cleanup trace before applying moves:

```text
source path | destination path | reason | evidence line
```

Suggested first candidates to audit:

- Directories with `spec.md` and `trace.md` where trace has complete/implemented markers.
- Historical Slack UI phase docs and `docs/PLANS/617-compact-tracking-plan.md` were audited and moved by the manifest above.

### 4. Update Links After Moves

After any `git mv`, run:

```bash
rg -n "old/path/or/file" README.md README.ko.md CLAUDE.md docs
```

Then run a markdown local-link resolver over changed docs. The previous one-liner used in this worktree:

```bash
node -e "const fs=require('node:fs'),path=require('node:path'); const files=process.argv.slice(1); const bad=[]; for (const f of files){ const text=fs.readFileSync(f,'utf8'); const re=/\\[[^\\]]+\\]\\(([^)]+)\\)/g; let m; while ((m=re.exec(text))){ const href=m[1].split('#')[0]; if (!href || /^[a-z]+:\\/\\//i.test(href) || href.startsWith('mailto:')) continue; const target=path.resolve(path.dirname(f), href); if (!fs.existsSync(target)) bad.push(`${f}: ${href}`); }} if (bad.length){ console.error(bad.join('\\n')); process.exit(1); } console.log('local markdown links ok');" README.md README.ko.md CLAUDE.md docs/README.md docs/archive/completed-work.md docs/adr/README.md docs/adr/0001-documentation-system-of-record.md docs/misc/research/2026-05-18-ai-agent-docs-organization.md docs/misc/handoffs/2026-05-18-docs-cleanup.md
```

### 5. Do Not Overwrite User Work

Main checkout currently has unrelated untracked files. The worktree is clean except for this docs branch's edits. Keep all further edits in:

```text
/Users/zhugehyuk/2lab.ai/soma-work/.worktree/docs-agent-research
```

## Completion Criteria For The Real Cleanup

The next completion claim should only happen after this checklist is satisfied:

- Root top-level file list is intentionally minimal or every remaining noisy item has a documented reason to stay.
- `docs/` top-level count is materially reduced or grouped by lifecycle.
- Completed docs and ADR/decision material are findable from `docs/README.md`.
- Moved docs have updated links.
- `git status --short` shows only intended cleanup changes.
- `git diff --check` passes.
- Local markdown link resolver passes for changed markdown files.
- Any skipped repo-wide lint/test failures are reported as baseline and unrelated.

## Suggested Final Shape

If doing a second cleanup commit, prefer these change groups:

1. Add/keep `docs/README.md`, `docs/archive/completed-work.md`, `docs/adr/`, `docs/misc/research/`, `docs/misc/handoffs/`.
2. Move clearly completed/stale docs into `docs/archive/`.
3. Move active feature specs/traces into a smaller grouped namespace.
4. Update root README/CLAUDE links.
5. Verify links and whitespace.

This is deliberately conservative: the user wants the mess reduced, but silent loss of active specs would be worse than leaving a few ambiguous directories in place.
