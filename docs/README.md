# soma-work Docs Map

`docs/`는 여섯 축으로만 본다. 루트에는 이 라우팅 문서와 큰
카테고리 디렉터리만 둔다.

## 1. Current

현재 계획 중이거나 구현/운영 중인 문서.

- [current/plans/](./current/plans/) — active feature specs, traces, plans
- [current/spec/](./current/spec/) — evergreen product/system specs
- [`/z` command master spec](./current/spec/z-command-master-spec.md)
- [goal-command/](./goal-command/) — goal command spec (top-level legacy location; new specs go under `current/`)

## 2. Stale Plans

계획했지만 시간이 지났거나 삭제/재검토 후보인 문서.

- [stale-plans/review-needed/](./stale-plans/review-needed/) — 오래된 plan-only, investigation-only, or drift-prone docs

여기 있는 문서는 바로 실행 계획으로 쓰지 말고 현재 코드와 이슈 상태를 먼저 확인한다.

## 3. Archive

완료했거나 historical reference로만 남긴 문서.

- [archive/features/](./archive/features/) — completed feature specs/traces
- [archive/plans/](./archive/plans/) — old plans
- [archive/debugging/](./archive/debugging/) — old debugging traces
- [archive/completed-work.md](./archive/completed-work.md) — completed work ledger

## 4. ADR

되돌리기 어렵거나 repo-wide 영향을 주는 결정.

- [adr/README.md](./adr/README.md)

## 5. Runbook

운영자가 절차대로 실행하는 배포, 롤백, 장애 대응 문서.

- [runbook/](./runbook/) — deployment, rollback, operational fix procedures

## 6. Misc

기타 운영/참조 문서. 새 feature 계획은 여기에 넣지 않는다.

- [misc/reference/](./misc/reference/) — architecture, workflow, Slack Block Kit reference
- [misc/guides/](./misc/guides/) — how-to and migration guides
- [misc/research/](./misc/research/) — dated research notes
- [misc/debugging/current/](./misc/debugging/current/) — current debug traces not yet archived
- [debugging/](./debugging/) — top-level legacy debug traces (new traces go under `misc/debugging/current/`)
- [misc/issues/current/](./misc/issues/current/) — issue-oriented helper docs
- [misc/configuration/current/](./misc/configuration/current/) — configuration notes
- [misc/handoffs/](./misc/handoffs/) — handoff notes

## Routing Rules

- 새 계획/feature spec/trace는 `docs/current/plans/<topic>/`에 둔다.
- 오래되어 바로 실행하면 위험한 계획은 `docs/stale-plans/review-needed/`에 둔다.
- 완료 증거가 명확한 문서는 `docs/archive/features/`로 보낸다.
- repo-wide 결정은 `docs/adr/`로 승격한다.
- 운영자가 순서대로 실행하는 절차서는 `docs/runbook/`에 둔다.
- Slack UI/API payload를 건드릴 때는 [Slack Block Kit reference](./misc/reference/slack-block-kit.md)를 먼저 확인한다.
