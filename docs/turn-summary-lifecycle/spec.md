# Turn Summary & Lifecycle — Spec

> STV Spec | Created: 2026-03-28

## 1. Overview

Turn completion 후 자동 요약, `es` 커맨드, 메시지 lifecycle 관리, Day-based 자동화 파이프라인을 soma-work에 추가한다.

핵심 가치: 유저가 세션을 떠나 있어도 작업 상태를 자동 요약하여 제공하고, 스레드 내 불필요한 상태 메시지를 자동 정리하며, 복잡한 멀티 스킬 워크플로우를 한 번의 명령으로 자동 실행한다.

## 2. User Stories

- As a user, I want automatic session summary after 180s of inactivity, so that I can quickly understand what happened when I return.
- As a user, I want to type `es` to get an immediate executive summary of my session's active issues and PRs.
- As a user, I want done/waiting messages to disappear when I give a new command, so that the thread stays clean.
- As a user, I want to issue a single command that runs the full day0→day1→day2 pipeline automatically, so that I don't have to manually orchestrate each phase.

## 3. Acceptance Criteria

- [ ] Turn completion (done/waiting) triggers a 180s timer; if no user input arrives, a forked session executes summary.prompt and displays the result
- [ ] Timer cancels if user sends a new command before 180s
- [ ] `es` command triggers summary.prompt immediately via forked session
- [ ] Summary result is appended to thread header message bottom (new `summaryBlocks` slot in ThreadSurface)
- [ ] Summary result persists until user sends next command, then is cleared
- [ ] done/waiting notification messages (separate thread messages) are deleted via `chat.delete` when user sends new command or clicks a decision button
- [ ] error notification messages are NOT deleted (persist)
- [ ] Day-based pipeline (`day0`→`day1`→`day2`) executes automatically from a single command
- [ ] Each day-phase completes before the next begins; user confirmation requested at phase boundaries
- [ ] Pipeline halts on unrecoverable error, reports status, and awaits user decision

## 4. Scope

### In-Scope
- `SummaryTimer` service: 180s countdown, cancel on user input, fork session on fire
- `EsHandler` command handler: immediate summary trigger
- `ThreadSurface` summary slot: append/clear summary blocks
- Turn completion message tracking & deletion
- `DayPipelineRunner`: sequential phase orchestration (day0→1→2)
- Each day-phase defined as a sequence of skill invocations

### Out-of-Scope
- Calendar-based scheduling (day0/1/2 are phases, not calendar days)
- Customizable summary.prompt per user (uses fixed template)
- Customizable timer duration per user (fixed 180s)
- Partial pipeline execution (e.g., start from day1 only) — future enhancement

## 5. Architecture

### 5.1 Layer Structure

```
User Input (Slack)
  │
  ├─ CommandRouter ──→ EsHandler ──→ SummaryService.execute()
  │
  ├─ StreamExecutor (turn complete)
  │     ├─ TurnNotifier.notify()  (existing)
  │     ├─ SummaryTimer.start()   (NEW)
  │     └─ CompletionMessageTracker.track(ts)  (NEW)
  │
  ├─ EventRouter (new user message)
  │     ├─ SummaryTimer.cancel()
  │     ├─ SummaryService.clearDisplay()
  │     └─ CompletionMessageTracker.deleteAll()
  │
  └─ DayPipelineRunner
        ├─ Phase day0: stv:debug → stv:new-task
        ├─ Phase day1: stv:new-task → stv:do-work → PR → verify loop → review → merge
        └─ Phase day2: report → codex/gemini review (4 parallel) → fix loop → merge
```

### 5.2 New Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `SummaryTimer` | `src/slack/summary-timer.ts` | Per-session 180s timer, cancel/fire logic |
| `SummaryService` | `src/slack/summary-service.ts` | Fork session, execute summary.prompt, return result |
| `EsHandler` | `src/slack/commands/es-handler.ts` | `es` command → SummaryService.execute() |
| `CompletionMessageTracker` | `src/slack/completion-message-tracker.ts` | Track & bulk-delete done/waiting message timestamps |
| `DayPipelineRunner` | `src/slack/pipeline/day-pipeline-runner.ts` | Sequential day0→1→2 orchestration |
| `DayPipelineHandler` | `src/slack/commands/day-pipeline-handler.ts` | Command to start pipeline |

### 5.3 SummaryTimer Detail

```typescript
class SummaryTimer {
  private timers = new Map<string, NodeJS.Timeout>(); // sessionKey → timer

  start(sessionKey: string, callback: () => void): void {
    this.cancel(sessionKey);
    this.timers.set(sessionKey, setTimeout(callback, 180_000));
  }

  cancel(sessionKey: string): void {
    const timer = this.timers.get(sessionKey);
    if (timer) { clearTimeout(timer); this.timers.delete(sessionKey); }
  }
}
```

### 5.4 SummaryService Detail — Session Fork

```typescript
class SummaryService {
  async execute(session: ConversationSession, sessionKey: string): Promise<string> {
    // 1. Fork: create temporary session with same model, working dir, links
    // 2. Inject summary.prompt into forked session
    // 3. Stream response, collect text
    // 4. Terminate forked session
    // 5. Return collected text
  }

  async displayOnThread(session: ConversationSession, sessionKey: string, summaryText: string): Promise<void> {
    // Append summary blocks to ThreadSurface via new summaryBlocks slot
  }

  async clearDisplay(sessionKey: string): Promise<void> {
    // Clear summaryBlocks from ThreadSurface, trigger re-render
  }
}
```

**summary.prompt template:**
```
현재 active issue, pr 각각에 대해 as-is to-be 형태로 리포트
stv:verify를 해주고 active issue, pr을 종합하여 executive summary

다음 유저가 내릴만한 행동을 3개 정도 제시해줘. 각각 복사하기 쉽게 코드 블럭으로 제시
```

### 5.5 CompletionMessageTracker Detail

```typescript
class CompletionMessageTracker {
  // sessionKey → Set<messageTs>
  private tracked = new Map<string, Set<string>>();

  track(sessionKey: string, messageTs: string, category: TurnCategory): void {
    if (category === 'Exception') return; // errors persist
    let set = this.tracked.get(sessionKey);
    if (!set) { set = new Set(); this.tracked.set(sessionKey, set); }
    set.add(messageTs);
  }

  async deleteAll(sessionKey: string, slackApi: SlackApiHelper, channel: string): Promise<void> {
    const set = this.tracked.get(sessionKey);
    if (!set || set.size === 0) return;
    await Promise.allSettled(
      [...set].map(ts => slackApi.deleteMessage(channel, ts))
    );
    this.tracked.delete(sessionKey);
  }
}
```

### 5.6 DayPipelineRunner Detail

```typescript
interface DayPhase {
  name: string; // 'day0' | 'day1' | 'day2'
  steps: PipelineStep[];
}

interface PipelineStep {
  skill: string;           // e.g. 'stv:debug', 'stv:new-task'
  args?: string;
  condition?: (ctx: PipelineContext) => boolean;
  parallel?: PipelineStep[]; // for day2 codex/gemini reviews
}

class DayPipelineRunner {
  private phases: DayPhase[] = [
    {
      name: 'day0',
      steps: [
        { skill: 'stv:debug' },
        { skill: 'stv:new-task', args: 'bug jira ticket' },
      ],
    },
    {
      name: 'day1',
      steps: [
        { skill: 'stv:new-task', condition: ctx => !ctx.hasIssue },
        { skill: 'stv:do-work' },
        // PR creation handled within do-work
        { skill: 'stv:verify', /* loop until pass */ },
        // github-pr review + fix/update workflow
      ],
    },
    {
      name: 'day2',
      steps: [
        // 1. Report: what was done, jira/pr links
        // 2. as-is/to-be + stv:verify + executive summary
        // 3. Parallel LLM reviews (codex code, codex test, gemini code, gemini test)
        // 4. Fix based on reviews → verify loop → merge
      ],
    },
  ];

  async run(session: ConversationSession): Promise<void> {
    for (const phase of this.phases) {
      await this.executePhase(phase, session);
      // Request user confirmation before next phase
    }
  }
}
```

### 5.7 Integration Points

| Existing Component | Integration |
|-------------------|-------------|
| `StreamExecutor` | After turn completion: call `SummaryTimer.start()` + `CompletionMessageTracker.track()` |
| `EventRouter` / `SlackHandler` | On new user message: call `SummaryTimer.cancel()` + `CompletionMessageTracker.deleteAll()` + `SummaryService.clearDisplay()` |
| `ThreadSurface` | New `summaryBlocks` slot in layout, rendered after Action buttons |
| `CommandRouter` | Register `EsHandler` + `DayPipelineHandler` |
| `ActionHandlers` (choice button click) | Call `CompletionMessageTracker.deleteAll()` |
| `TurnNotifier` | No changes — existing fire-and-forget notification unchanged |

## 6. Non-Functional Requirements

- **Performance**: Summary fork session should complete within 30s. Timer operations O(1).
- **Reliability**: Timer survives within process lifetime. Service restart clears all timers (acceptable — 180s window is short).
- **Memory**: CompletionMessageTracker stores only message timestamps (Set<string>), minimal footprint.
- **Concurrency**: One summary timer per session. New turn completion resets existing timer.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| `EsHandler` class + `es-handler.ts` file naming | tiny | Follows existing `CommandHandler` naming convention |
| Timer constant `180_000ms` | tiny | User specified 180 seconds |
| Timer cancel via `clearTimeout` on user input | small | Standard JS timer pattern, ~5 lines |
| Summary blocks as new ThreadSurface slot | small | Follows existing Choice slot pattern in ThreadSurface |
| Error messages excluded from deletion | tiny | Single condition check on `TurnCategory === 'Exception'` |
| DayPipelineRunner as single orchestrator class | small | Clean separation, one file, follows existing StreamExecutor pattern |
| Pipeline command name: `pipeline` or `autowork` | tiny | Will use `autowork` — distinct from existing commands |

## 8. Open Questions

None — all decisions resolved.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/turn-summary-lifecycle/spec.md`
