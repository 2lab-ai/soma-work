# Architecture Decision Records

ADR은 repo 전반에 영향을 주고 되돌리기 어려운 결정을 기록한다. 작은 구현 중 선택, switching-cost 판단, 테스트 순서 같은 내용은 각 feature의 `Auto-Decisions` 표에 둔다.

## ADR 규칙

- 파일명: `000N-short-title.md`
- 필수 필드: Status, Date, Context, Decision, Consequences, Evidence
- Status 값: `Proposed`, `Accepted`, `Superseded`, `Rejected`
- Superseded이면 새 ADR 링크를 남긴다.
- code path, spec, trace, PR/issue, 외부 자료 링크를 함께 남긴다.

## ADR Index

| ID | Status | Date | Decision |
|----|--------|------|----------|
| [0001](./0001-documentation-system-of-record.md) | Accepted | 2026-05-18 | `docs/README.md`, dated research, completion ledger, ADR index를 문서 system-of-record로 둔다. |

## Embedded Decision Sources

기존 문서에는 ADR 이전의 decision log가 많이 들어 있다. 새 ADR 작성 전에는 아래 문서를 먼저 확인한다.

| 영역 | 문서 |
|------|------|
| Facade/SRP/pipeline architecture | [../architecture.md](../misc/reference/architecture.md), [../workflow.md](../misc/reference/workflow.md) |
| Slack Block Kit/API guardrails | [../slack-block-kit.md](../misc/reference/slack-block-kit.md) |
| CCT/AuthKey token rotation | [../cct-redesign/spec.md](../stale-plans/review-needed/cct-redesign/spec.md), [../cct-token-rotation/spec.md](../current/plans/cct-token-rotation/spec.md) |
| Handoff entrypoints/budget/safe-stop | [../archive/features/handoff-entrypoints/spec.md](../archive/features/handoff-entrypoints/spec.md), [../archive/features/handoff-budget/spec.md](../archive/features/handoff-budget/spec.md), [../archive/features/dispatch-safe-stop/spec.md](../archive/features/dispatch-safe-stop/spec.md) |
| PR issue precondition guard | [../archive/features/pr-issue-precondition/spec.md](../archive/features/pr-issue-precondition/spec.md) |
| Turn end surface guarantee | [../turn-end-surface-guarantee/trace.md](../current/plans/turn-end-surface-guarantee/trace.md) |
| Docs cleanup/gardening | [../archive/features/docs-cleanup/spec.md](../archive/features/docs-cleanup/spec.md), [../archive/features/project-gardening/spec.md](../archive/features/project-gardening/spec.md) |

## When To Promote To ADR

Promote a decision when at least one condition is true:

- It changes the repo-wide documentation, testing, deployment, or agent workflow contract.
- It creates a new top-level directory or changes where future work should live.
- It sets a policy future agents must follow across unrelated tasks.
- It supersedes a previous architecture or operational decision.

Do not promote one-off bugfix details, temporary investigation notes, or local test decisions.
