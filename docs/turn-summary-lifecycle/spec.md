# Turn Summary Lifecycle — Spec

> STV Spec | Created: 2026-03-28 | Status: Implemented (Day Pipeline removed)

## 1. Overview

Turn Summary Lifecycle는 "세션 턴이 끝난 뒤 무슨 일이 일어나는가"를 관리하는 post-turn 인프라다.
180초 타이머로 자동 executive summary를 생성하고, `es` 커맨드로 즉시 요약을 트리거하며,
완료 메시지의 생명주기(추적/삭제/에러 보존)를 통합 관리한다.

핵심 원칙: **유저가 떠난 뒤에도 세션은 스스로 정리하고 요약한다.**

## 2. User Stories

- As a user, I want an automatic executive summary 180s after my last interaction, so I can review progress later
- As a user, I want the summary cancelled if I send new input (stale summary 방지)
- As a user, I want to trigger an immediate summary via `es` command
- As a user, I want old completion messages cleaned up when I send new input (thread 정리)
- As a user, I want error messages to persist even when other messages are cleaned up

## 3. Acceptance Criteria

- [x] Turn 완료 후 180초 타이머 시작
- [x] 유저 입력 시 타이머 취소
- [x] 타이머 발화 → session fork → summary prompt 실행 → thread header에 표시
- [x] `es` 커맨드 → 즉시 summary prompt 주입 (CONTINUE_SESSION 경유)
- [x] 유저 새 입력 시 summary 표시 제거
- [x] 완료 메시지(done/waiting) ts 추적, 유저 입력/버튼 클릭 시 bulk delete
- [x] Exception 카테고리 메시지는 삭제 대상에서 제외 (에러 보존)
- [x] Thread root message (header)는 절대 삭제 불가 (defense-in-depth protect)
- [x] AbortController로 stale summary fork 중단
- [x] 삭제 실패 시 re-track하여 재시도 가능

## 4. Scope

### In-Scope
- SummaryTimer: 180초 per-session 타이머
- SummaryService: fork executor → summary 생성 + Block Kit 표시/제거
- EsHandler: `es` 커맨드 핸들러
- CompletionMessageTracker: 메시지 ts 추적/삭제/보호
- ForkExecutor: 실제 LLM summary 호출 (ClaudeHandler.dispatchOneShot)

### Out-of-Scope
- Day Pipeline Orchestration (구현 후 삭제됨 — #139에서 추가, #149에서 제거)
- Summary 커스터마이징 (프롬프트 고정)
- Summary 이력 저장

### Attempted & Removed
- **DayPipelineRunner** (`src/slack/pipeline/day-pipeline-runner.ts`): day0(debug)→day1(implement)→day2(review) 순차 파이프라인. #139에서 구현, #149에서 "mistakenly implemented, not a requested feature"로 삭제
- **DayPipelineHandler** (`src/slack/commands/day-pipeline-handler.ts`): `autowork` 커맨드. #149에서 삭제

## 5. Architecture

### 5.1 Layer Structure

```
Turn Completion
  ↓ onTurnEnd event
SummaryTimer (180s)                         ← start/cancel per session
  ↓ timer fires
SummaryService                              ← buildPrompt → forkExecutor → displayOnThread
  ↓ fork
ForkExecutor (ClaudeHandler.dispatchOneShot) ← Real LLM call with AbortController
  ↓ result
ThreadSurface (actionPanel.summaryBlocks)   ← Block Kit rendering on thread header

User Input / es Command
  ↓
SummaryTimer.cancel()                       ← Reset timer
CompletionMessageTracker.deleteAll()        ← Cleanup old messages
SummaryService.clearDisplay()               ← Remove summary blocks
```

### 5.2 Key Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `SummaryTimer` | `src/slack/summary-timer.ts` | Per-session 180s setTimeout, start/cancel/cancelAll |
| `SummaryService` | `src/slack/summary-service.ts` | Summary prompt building, fork execution, Block Kit display |
| `CompletionMessageTracker` | `src/slack/completion-message-tracker.ts` | Track/delete completion messages, protect thread roots |
| `EsHandler` | `src/slack/commands/es-handler.ts` | `es` command → inject SUMMARY_PROMPT |
| `ForkExecutor` | `src/slack/create-fork-executor.ts` | Factory for ClaudeHandler.dispatchOneShot wrapper |
| `ThreadSurface` | `src/slack/thread-surface.ts` | Single-writer surface for thread header rendering |

### 5.3 Data Model

```typescript
// SummaryTimer — in-memory only
Map<sessionKey, NodeJS.Timeout>

// CompletionMessageTracker — in-memory only
Map<sessionKey, Set<messageTs>>     // tracked: deletable messages
Map<sessionKey, Set<messageTs>>     // protectedTs: undeletable (thread roots)

// SummaryService output → ActionPanel
interface ActionPanel {
  summaryBlocks?: SlackBlock[];     // Set by displayOnThread, cleared by clearDisplay
}
```

### 5.4 Summary Prompt (Fixed)

```
현재 active issue, pr 각각에 대해 as-is to-be 형태로 리포트
stv:verify를 해주고 active issue, pr을 종합하여 executive summary

다음 유저가 내릴만한 행동을 3개 정도 제시해줘. 각각 복사하기 쉽게 코드 블럭으로 제시
```

Context prefix: active issue URL + active PR URL (from session.links)

### 5.5 Integration Points

| Integration | Mechanism |
|-------------|-----------|
| Turn completion → timer start | `StreamExecutor.execute()` → `SummaryTimer.start()` |
| User input → timer cancel | `StreamExecutor` input handler → `SummaryTimer.cancel()` |
| User input → message cleanup | `CompletionMessageTracker.deleteAll()` fire-and-forget |
| User input → summary clear | `SummaryService.clearDisplay()` |
| Timer fire → fork | `SummaryService.execute(session, abortSignal)` |
| Fork result → display | `SummaryService.displayOnThread()` → `ThreadSurface.render()` |
| `es` command → inject | `EsHandler.execute()` returns `{ continueWithPrompt: SUMMARY_PROMPT }` |
| Button click → cleanup | `ChoiceActionHandler` → `CompletionMessageTracker.deleteAll()` |
| Bot-initiated init → protect | `ThreadSurface.initialize()` → `tracker.protect(sessionKey, threadRootTs)` |

### 5.6 Block Kit Rendering

- Summary displayed as `*Executive Summary*` header + section blocks
- Long text split at newline boundaries, max 3000 chars per section (Slack limit)
- Divider block precedes summary content

## 6. Non-Functional Requirements

- **Performance**: 180s timer is lightweight (setTimeout). Fork executor reuses existing session infrastructure
- **Reliability**: AbortController cancels stale forks. Failed deletions re-tracked for retry. Protected timestamps never deleted
- **Race Safety**: snapshot-then-remove pattern in deleteAll(). Abort check after await in execute()

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 180s timer duration | tiny | Empirically determined — enough to confirm user left |
| Fixed summary prompt (Korean) | tiny | Product decision, not user-configurable |
| Fire-and-forget deletion | small | Non-critical path, `.catch(() => {})` pattern |
| Exception messages persist | small | Errors are diagnostic — user needs to see them |
| Defense-in-depth thread root protection | small | Multiple deletion paths existed; protect at source |
| DayPipeline removal | medium | Implemented prematurely without spec approval, removed in #149 |

## 8. Open Questions

- Summary prompt customization per user/team — currently hardcoded
- Summary result persistence/history — currently ephemeral
- Day Pipeline Orchestration — removed, needs separate spec if revisited

## 9. Implementation History (PRs)

| PR | Date | Title | Status |
|----|------|-------|--------|
| [#139](https://github.com/2lab-ai/soma-work/pull/139) | 2026-03-28 | feat: turn summary lifecycle (180s timer, es cmd, message cleanup, day pipeline) | Merged |
| [#147](https://github.com/2lab-ai/soma-work/pull/147) | 2026-03-28 | refactor: SummaryService ForkExecutor DI pattern | Merged |
| [#149](https://github.com/2lab-ai/soma-work/pull/149) | feat: production ForkExecutor wiring + **DayPipeline cleanup** (DELETED) | Merged |
| [#150](https://github.com/2lab-ai/soma-work/pull/150) | 2026-03-28 | fix: wire CompletionMessageTracker into ChoiceActionHandler (S8) | Merged |
| [#208](https://github.com/2lab-ai/soma-work/pull/208) | 2026-03-30 | fix: stop deleting thread header on completion message cleanup | Merged |
| [#226](https://github.com/2lab-ai/soma-work/pull/226) | 2026-03-30 | fix: trigger thread panel re-render after summary timer display | Merged |
| [#229](https://github.com/2lab-ai/soma-work/pull/229) | 2026-03-30 | test: AC3 unit tests for summary timer render trigger | Merged |
| [#232](https://github.com/2lab-ai/soma-work/pull/232) | 2026-03-30 | fix: auto executive summary gets session context via resume | Merged |
| [#233](https://github.com/2lab-ai/soma-work/pull/233) | 2026-03-30 | fix: address codex review findings — race safety, error handling, text limits | Merged |
| [#252](https://github.com/2lab-ai/soma-work/pull/252) | 2026-03-30 | fix: defense-in-depth protection for thread header deletion | Merged |
| [#267](https://github.com/2lab-ai/soma-work/pull/267) | 2026-03-30 | fix: prevent stale summary race via AbortController threading | Merged |

## 10. Scenarios (7, Day Pipeline excluded)

| # | Scenario | Size | Status |
|---|----------|------|--------|
| S1 | Timer Start on Turn Completion | small | Implemented |
| S2 | Timer Cancel on User Input | small | Implemented |
| S3 | Timer Fire → Fork Session → Summary Display | large | Implemented |
| S4 | ES Command → Immediate Summary | small | Implemented |
| S5 | Summary Clear on New User Input | small | Implemented |
| S6 | Completion Message Track/Delete | medium | Implemented |
| S7 | Error Messages Persist | small | Implemented |

### Removed Scenario

| # | Scenario | Size | Status |
|---|----------|------|--------|
| ~~S8~~ | ~~Day Pipeline Orchestration~~ | ~~xlarge~~ | **Removed** (#139→#149) |

## 11. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/turn-summary-lifecycle/spec.md`
→ Day Pipeline은 별도 spec이 필요하면 재설계 후 추가
