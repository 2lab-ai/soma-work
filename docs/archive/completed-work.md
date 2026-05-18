# Completed Work Ledger

> Last audited: 2026-05-18

이 원장은 "이미 완료된 내용"을 새 agent가 빠르게 찾기 위한 색인이다. 완료 판정은 문서 안의 명시적 `Done`, `Complete`, `Implemented`, `구현 완료`, archive 이동 기록 같은 증거에 기반한다.

## 상태 기준

- **Completed**: trace/spec에 완료 증거가 명시됨.
- **Archived**: 완료되었거나 historical reference로 분류되어 `docs/archive/`로 이동됨.
- **Partial**: 일부 scenario/task만 완료 증거가 있고 전체 feature 완료는 확정하지 않음.
- **Unclassified**: feature directory는 있으나 완료 증거가 애매함. 이 원장에 올리지 않는다.

## Documentation Cleanup

| Work | Status | Evidence |
|------|--------|----------|
| Docs Cleanup & Update | Archived / Completed | [archive/features/docs-cleanup/spec.md](./features/docs-cleanup/spec.md), [trace.md](./features/docs-cleanup/trace.md) |
| Project Gardening | Archived / Completed | [archive/features/project-gardening/spec.md](./features/project-gardening/spec.md), [trace.md](./features/project-gardening/trace.md) |
| README rewrite and root cleanup | Completed | [archive/features/project-gardening/trace.md](./features/project-gardening/trace.md) scenarios 1-10 |
| Historical docs archive | Completed | [archive/](./) and [archive/features/project-gardening/trace.md](./features/project-gardening/trace.md) |

## Archived Feature Docs

These are not the default starting point for current implementation work. Use them as history or regression context.

| Feature | Location |
|---------|----------|
| Admin commands | [archive/features/admin-commands/](./features/admin-commands/) |
| Docs cleanup | [archive/features/docs-cleanup/](./features/docs-cleanup/) |
| Ghost session fix | [archive/features/ghost-session-fix/](./features/ghost-session-fix/) |
| Issue 64 mid-thread fix v2 | [archive/features/issue64-midthread-fix-v2/](./features/issue64-midthread-fix-v2/) |
| Main deploy migration | [archive/features/main-deploy-migration/](./features/main-deploy-migration/) |
| Media file support | [archive/features/media-file-support/](./features/media-file-support/) |
| MCP session tick | [archive/features/mcp-session-tick/](./features/mcp-session-tick/) |
| Mid-thread initial response | [archive/features/mid-thread-initial-response/](./features/mid-thread-initial-response/) |
| Portrait extractor | [archive/features/portrait-extractor/](./features/portrait-extractor/) |
| Project gardening | [archive/features/project-gardening/](./features/project-gardening/) |
| Daily/weekly report storage and lifecycle | [archive/features/daily-weekly-report/](./features/daily-weekly-report/) |
| Dispatch safe-stop | [archive/features/dispatch-safe-stop/](./features/dispatch-safe-stop/) |
| Handoff budget and recursion guard | [archive/features/handoff-budget/](./features/handoff-budget/) |
| Handoff deterministic entrypoints | [archive/features/handoff-entrypoints/](./features/handoff-entrypoints/) |
| PR issue precondition | [archive/features/pr-issue-precondition/](./features/pr-issue-precondition/) |
| PR workflow transition command | [archive/features/pr-workflow-transition-command/](./features/pr-workflow-transition-command/) |
| Rich turn notification | [archive/features/rich-turn-notification/](./features/rich-turn-notification/) |
| Session workspace isolation | [archive/features/session-workspace-isolation/](./features/session-workspace-isolation/) |
| Slash commands | [archive/features/slash-commands/](./features/slash-commands/) |
| Slack MCP cross-thread | [archive/features/slack-mcp-cross-thread/](./features/slack-mcp-cross-thread/) |
| Slack UI phase docs | [archive/features/slack-ui/](./features/slack-ui/) |
| Turn notification | [archive/features/turn-notification/](./features/turn-notification/) |
| User profile variables | [archive/features/user-profile-variables/](./features/user-profile-variables/) |

## Archived Plans

| Plan | Location |
|------|----------|
| Issue #617 compact tracking plan | [archive/plans/617-compact-tracking-plan.md](./plans/617-compact-tracking-plan.md) |

## Evidence-Backed Implemented / Completed Active Docs

These docs remain outside archive because they are still useful as current architecture or operational references.

| Work | Status | Evidence |
|------|--------|----------|
| Cron scheduler | Implemented | [cron-scheduler/spec.md](../current/plans/cron-scheduler/spec.md), [trace.md](../current/plans/cron-scheduler/trace.md) |
| Turn summary lifecycle | Implemented | [turn-summary-lifecycle/spec.md](../current/plans/turn-summary-lifecycle/spec.md), [trace.md](../current/plans/turn-summary-lifecycle/trace.md) |
| AuthKey v2 / CCT token rotation | Authoritative current trace | [cct-token-rotation/trace-v2.md](../current/plans/cct-token-rotation/trace-v2.md), [spec.md](../current/plans/cct-token-rotation/spec.md) |

## Partial Completion Evidence

These traces show completed scenarios but do not by themselves prove the whole feature is closed.

| Work | Evidence |
|------|----------|
| Multi-agent scenarios | [multi-agent/trace.md](../current/plans/multi-agent/trace.md) |
| Turn notification archived scenarios | [archive/features/turn-notification/trace.md](./features/turn-notification/trace.md) |

## ADR / Decision References

Use [adr/README.md](../adr/README.md) as the durable decision index. Existing decision-heavy docs include:

- [architecture.md](../misc/reference/architecture.md)
- [workflow.md](../misc/reference/workflow.md)
- [slack-block-kit.md](../misc/reference/slack-block-kit.md)
- [archive/features/handoff-budget/spec.md](./features/handoff-budget/spec.md)
- [archive/features/dispatch-safe-stop/spec.md](./features/dispatch-safe-stop/spec.md)
- [archive/features/pr-issue-precondition/spec.md](./features/pr-issue-precondition/spec.md)
- [archive/features/project-gardening/spec.md](./features/project-gardening/spec.md)

## Maintenance

- Add to this file only when the linked doc has explicit completion evidence.
- Do not infer completion from directory name alone.
- Prefer linking to `trace.md` because it records verification and implementation evidence.
- Move docs to `docs/archive/` only when staleness/completion is clear.
