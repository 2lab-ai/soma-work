# PR Workflow Transition Command & Merge Gate — Spec

> STV Spec | Created: 2026-03-10

## 1. Overview

`UIAskUserQuestion`로 유저가 선택한 다음 행동을 **모델이 host에 전달하는 명시적 MCP command**로 이어서, PR 리뷰/픽스/머지 흐름을 수동 입력 없이 재진입시키는 기능을 추가한다.

핵심 목표는 두 가지다.

1. `pr-review` / `pr-fix-and-update`가 "질문 → 선택 → 다음 워크플로우 전환"을 직접 소유하게 만든다.
2. PR 머지를 더 이상 action panel의 direct button으로 수행하지 않고, **CI 성공 + 승인 상태 + 변경 문맥**을 정리한 뒤 유저에게 마지막으로 묻는 merge gate를 통과해야만 수행되게 만든다.

이 변경으로 `new fix <PR_URL>`, `new <PR_URL>`를 유저가 직접 다시 입력하지 않아도 되고, PR 수정 후 자동 재리뷰, CI 실패 시 재픽스, CI 성공 후 merge 확인까지 하나의 통제된 흐름으로 묶인다.

## 2. User Stories

- As a PR reviewer, I want review 결과 질문에서 바로 fix/re-review/wait를 선택하고, so that 내가 명령어를 다시 입력하지 않아도 된다.
- As a PR fixer, I want fix 후 자동으로 PR review workflow로 다시 들어가고 필요하면 다시 fix loop로 돌아가길, so that 수정과 재검토를 반복해도 흐름이 끊기지 않는다.
- As a PR owner, I want merge 전에 CI 상태, 승인자, 변경 이유를 한 번에 보고 결정하길, so that 문맥 없이 머지하는 실수를 막을 수 있다.
- As a bot maintainer, I want workflow handoff를 모델-command 기반 continuation으로 처리하길, so that Slack UI choice와 host-side session reset/dispatch가 일관된 방식으로 연결된다.

## 3. Acceptance Criteria

- [ ] model-command에 `CONTINUE_SESSION` 명령이 추가된다.
- [ ] `CONTINUE_SESSION`은 최소한 `prompt`, `resetSession`, `dispatchText`, `forceWorkflow`를 지원한다.
- [ ] `forceWorkflow`가 있으면 host는 dispatch 결과 추론에 의존하지 않고 지정된 workflow로 재진입한다.
- [ ] `ASK_USER_QUESTION` 선택 결과를 받은 뒤 모델이 `CONTINUE_SESSION`을 호출하면, host는 continuation loop를 통해 실제 세션 reset + workflow handoff를 수행한다.
- [ ] `pr-review` workflow는 CI 상태를 1분 간격으로 확인하고, 실패 시 decision gate를 거쳐 fix 또는 대기를 결정한다.
- [ ] `pr-review` workflow는 CI 성공 + merge 가능 상태일 때만 merge check 질문을 띄운다.
- [ ] merge check 질문에는 AS-IS / TO-BE / 필요한 이유, approve 한 사람/근거, CI 상태가 모두 포함된다.
- [ ] merge check의 선택지에는 최소 `머지한다`, `다시 PR리뷰`, `다른 유저 리뷰 대기`가 있다.
- [ ] `pr-fix-and-update` workflow는 push 후 자동으로 `pr-review` workflow를 다시 진행한다.
- [ ] PR review/fix workflow에서는 direct merge button이 노출되지 않는다.

## 4. Scope

### In-Scope

- model-command schema/validator/catalog/result 처리 확장
- host continuation 타입 및 Slack handler continuation loop 확장
- `SessionInitializer`에 force-workflow 재진입 경로 추가
- `pr-review.prompt`, `pr-fix-and-update.prompt` handoff 규칙 개편
- PR 상태 수집 계층에 CI/approval/merge gate 문맥 추가
- action panel에서 PR workflow용 direct merge 제거
- 관련 unit/integration test 추가

### Out-of-Scope

- GitHub merge API 자체를 다른 provider로 일반화
- deploy/jira/onboarding 등 비-PR workflow의 대규모 재설계
- 백그라운드 worker 기반 비동기 CI polling
- reviewer assignment 자동화
- PR approval 규칙의 저장소별 정책 설정 UI

## 5. Architecture

### 5.1 Layer Structure

```
Model
  └─ mcp__model-command__run("ASK_USER_QUESTION")
       └─ Slack choice UI
            └─ user selection
                 └─ Model
                      └─ mcp__model-command__run("CONTINUE_SESSION")
                           └─ StreamExecutor parses command result
                                └─ returns Continuation(forceWorkflow?)
                                     └─ SlackHandler continuation loop
                                          └─ reset session + forced workflow handoff
```

PR workflow 쪽은 다음처럼 확장한다.

```
pr-fix-and-update
  └─ push + local verification
       └─ CONTINUE_SESSION(resetSession=true, forceWorkflow='pr-review')
            └─ pr-review
                 ├─ review summary / approval handling
                 ├─ CI poll every 60s
                 ├─ failure -> decision gate -> fix loop
                 └─ success -> merge gate question
```

### 5.2 Internal Commands / Workflow Touchpoints

| Surface | Location | Purpose |
|--------|----------|---------|
| `ASK_USER_QUESTION` | `src/model-commands/*`, `src/slack/pipeline/stream-executor.ts` | Slack UI 질문 렌더링 |
| `CONTINUE_SESSION` | `src/model-commands/*`, `src/slack/pipeline/stream-executor.ts` | 모델이 host에 다음 workflow/continuation 지시 |
| Continuation loop | `src/slack-handler.ts` | reset + dispatch + 다음 프롬프트 실행 |
| Forced workflow entry | `src/slack/pipeline/session-initializer.ts` | dispatch 추론 없이 지정 workflow로 진입 |
| PR review prompt | `src/prompt/workflows/pr-review.prompt` | CI wait + merge gate + recursive handoff |
| PR fix prompt | `src/prompt/workflows/pr-fix-and-update.prompt` | push 후 auto re-review |
| PR action panel | `src/slack/action-panel-builder.ts`, `src/slack/actions/action-panel-action-handler.ts` | direct merge 제거, review/fix 재진입 유지 |

### 5.3 State and Data Contracts

#### `CONTINUE_SESSION` command

권장 payload:

```json
{
  "commandId": "CONTINUE_SESSION",
  "params": {
    "prompt": "new fix https://github.com/org/repo/pull/123",
    "resetSession": true,
    "dispatchText": "fix https://github.com/org/repo/pull/123",
    "forceWorkflow": "pr-fix-and-update"
  }
}
```

설계 원칙:

- `prompt`는 실제 다음 실행에 사용한다.
- `dispatchText`는 workflow 분류 또는 링크 추출에 사용한다.
- `forceWorkflow`는 dispatch classifier를 우회해 deterministic handoff를 보장한다.
- `forceWorkflow`가 설정되면 `resetSession`은 반드시 `true`여야 한다.

#### PR metadata extension

PR merge gate에 필요한 host-side 정보:

- latest review aggregate (`approved`, `changes_requested`, `pending`)
- approver 목록과 마지막 review state
- mergeability (`state`, `draft`, `merged`, `mergeableState`)
- CI / check summary (`pending`, `success`, `failure`, failing check names`)

### 5.4 Integration Points

- `src/model-commands/types.ts`
- `src/model-commands/catalog.ts`
- `src/model-commands/validator.ts`
- `src/model-command-mcp-server.ts`
- `src/slack/pipeline/stream-executor.ts`
- `src/slack-handler.ts`
- `src/types.ts`
- `src/slack/pipeline/session-initializer.ts`
- `src/slack/action-panel-builder.ts`
- `src/slack/actions/action-panel-action-handler.ts`
- `src/link-metadata-fetcher.ts`
- `src/prompt/workflows/pr-review.prompt`
- `src/prompt/workflows/pr-fix-and-update.prompt`

## 6. Non-Functional Requirements

- **Determinism**: workflow handoff는 prompt parsing에만 의존하지 않고 `forceWorkflow`로 강제 가능해야 한다.
- **Safety**: PR merge는 direct button으로 우회되지 않아야 하며, merge gate 질문이 항상 마지막 승인/CI 문맥을 포함해야 한다.
- **Slack Compatibility**: `ASK_USER_QUESTION` payload는 기존 `user_choice` / `user_choice_group` 규칙과 Block Kit 제한을 지켜야 한다.
- **Observability**: continuation 명령 수신, forceWorkflow 적용, CI poll 결과, merge gate 진입을 로그로 남긴다.
- **Testability**: model-command validation, continuation parsing, forced workflow reset, panel visibility, prompt regression을 각각 독립 테스트할 수 있어야 한다.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 새 command 이름을 `CONTINUE_SESSION`으로 둔다 | small | workflow handoff뿐 아니라 future continuation에도 재사용 가능하며 현재 `Continuation` 구조와 가장 직접적으로 매핑된다 |
| `forceWorkflow`는 `WorkflowType` allowlist만 허용한다 | small | arbitrary string은 invalid workflow/state corruption 위험이 크다 |
| `forceWorkflow` 사용 시 `resetSession=true`를 강제한다 | small | 기존 세션의 workflow/context를 유지한 채 workflow만 바꾸면 dispatch/links/history 일관성이 깨진다 |
| PR workflow의 direct merge button을 숨긴다 | small | merge gate를 우회하는 현재 경로를 제거하는 것이 요구사항과 가장 일치한다 |
| CI polling interval은 60초 고정으로 시작한다 | tiny | 유저 명시 요구사항이며 별도 설정 계층 추가는 YAGNI다 |
| merge check 선택지는 3개 기본안으로 고정한다 | small | 요청된 핵심 행동이 명확하고 Slack choice UI의 단순성이 중요하다 |

## 8. Open Questions

None.

## 9. Next Step

→ `docs/pr-workflow-transition-command/trace.md`로 scenario-level vertical trace를 작성하고, 그 시나리오를 구현 태스크 리스트로 사용한다.
