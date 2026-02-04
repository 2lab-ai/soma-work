# Slack Session Header & Action Panel Specification

## Version
- Document Version: 1.0
- Last Updated: 2026-02-04
- Scope: Slack UI enhancement for session header + action panel
- Source Files (current/future):
  - `src/slack/pipeline/session-initializer.ts`
  - `src/slack/pipeline/stream-executor.ts`
  - `src/slack/actions/channel-route-action-handler.ts`
  - `src/slack/stream-processor.ts`
  - `src/slack/actions/choice-action-handler.ts`
  - `src/slack/actions/form-action-handler.ts`
  - `src/slack/slack-api-helper.ts`
  - New: `src/slack/thread-header-builder.ts`
  - New: `src/slack/action-panel-builder.ts`
  - New: `src/slack/action-panel-manager.ts`

## 1. Goals
- **Two-message session UI**:
  1) **Thread header message** (public, thread root): high-visibility summary for the session.
  2) **Action panel message** (ephemeral, channel root): buttons + user-choice UI.
- **Modern, minimal, high-visibility layout** using Block Kit + attachments color bar.
- **Action panel mirrors UIAskUserQuestion** content (same options, same behavior).
- **All buttons default disabled** and only enabled when the AI response is done and it is the user's turn.
- **Workflow-aware buttons**:
  - PR review workflow shows **fix PR** + **approve PR**.
- **Channel-level action panel only** (not thread message).

## 2. Non-Goals
- Reply count display (Slack already shows this).
- Public channel action panel (must be ephemeral).
- Automatic UI style for every Slack message (scope is only header + action panel).

## 3. UX Summary

### 3.1 Thread Header (Public, Thread Root)
- Purpose: A single, highly visible snapshot of the session state.
- Location: Root message of the thread (bot-authored so it can be updated).
- Visual: Attachment color bar + compact hierarchy.

Example (concept):
```
@Z | 작업중 | PTN-123 · PR-591: feature X 구현
🤖 Sonnet 4.5 · 🕐 방금 전 · ⏳ 23시간 59분 남음
🔗 PTN-123 | PR-591 | 문서
```

### 3.2 Action Panel (Ephemeral, Channel Root)
- Purpose: One-click workflow controls and user choices without entering the thread.
- Location: **Channel root** (no `thread_ts`), **ephemeral** to the session owner.
- Two rows of buttons (actions block limit = 5 elements).
- All buttons **disabled by default**; enabled only when user can act.

Example (concept):
```
[종료] [이슈 리서치] [PR 생성] [PR 리뷰] [PR 문서화]
[fix PR] [approve PR]
```

### 3.3 UIAskUserQuestion in Action Panel
- When UIAskUserQuestion is emitted, append the same UI to the action panel (below buttons).
- When user submits, the appended UI disappears from the action panel.
- The thread continues exactly as today.

## 4. Block Kit Design

### 4.1 Status Colors (Attachment Bar)
- working: blue (active)
- waiting: amber (user input needed)
- idle/completed: green (ready or done)

### 4.2 Thread Header Blocks (Attachment + Blocks)
```
attachment.color = statusColor
blocks:
  - header: "@Z | 작업중 | PTN-123 · PR-591: feature X 구현"
  - context: "🤖 Sonnet 4.5 · 🕐 방금 전 · ⏳ 23시간 59분 남음"
  - section: "🔗 <issue|PTN-123> | <pr|PR-591> | <doc|문서>"
```

### 4.3 Action Panel Blocks (Ephemeral)
```
blocks:
  - context: "🎯 세션 컨트롤 · <thread|스레드 열기>"
  - actions (row 1): 종료, 이슈 리서치, PR 생성, PR 리뷰, PR 문서화
  - actions (row 2): fix PR, approve PR (pr-review only)
  - optional: UIAskUserQuestion blocks appended (same as thread UI)
```

## 5. Action Buttons & Behavior

### 5.1 Button Set
- **종료**: terminate session (existing handler behavior).
- **이슈 리서치**: `new <ISSUE_URL>` → `jira-brainstorming`.
- **PR 생성**: `new fix <ISSUE_URL>` → `jira-create-pr`.
- **PR 리뷰**: `new <PR_URL>` → `pr-review`.
- **fix PR** (pr-review only): `new fix <PR_URL>` → `pr-fix-and-update`.
- **approve PR** (pr-review only): `이슈 없으면 PR approve 처리 요청` (no /new).
- **PR 문서화**: `new <DOC_URL> <PR_URL>` → `pr-docs-confluence`.

### 5.2 Enable/Disable Rules
- **Disabled by default**.
- Enabled only when:
  - `activityState` is `waiting` or `idle`, **and**
  - there is **no active request** for the session.
- Buttons that require missing links stay disabled and show a short hint in context text.

## 6. UIAskUserQuestion Mirroring

### 6.1 Render
- When StreamProcessor detects `UserChoice` or `UserChoices`, build blocks via `ChoiceMessageBuilder`.
- Action panel appends those blocks **after** the actions section.
- Action panel title line changes to `유저 컨펌 대기`.

### 6.2 Submit/Clear
- On submit, action panel re-renders without the appended choice blocks.
- Thread behavior remains unchanged.

## 7. State Model

### 7.1 Session State Fields
Add a small state object on `ConversationSession`:
```
actionPanel?: {
  enabled: boolean;
  waitingForUser: boolean;
  choiceHash?: string;
  lastRenderedAt?: number;
}
```

### 7.2 State Transitions
- Session created → action panel posted (disabled).
- Stream start → disable panel.
- Stream end:
  - `hasUserChoice` → waiting + enable.
  - no choice → idle + enable.
- Choice submit → waiting false + re-render.

### 7.3 De-duplication
- Re-render only when state changes (enabled flag, waiting flag, choice hash).

## 8. Integration Points

### 8.1 Thread Header
- `SessionInitializer`:
  - bot-initiated thread root should use `ThreadHeaderBuilder` for initial header.
- `ChannelRouteActionHandler`:
  - new thread root message created in target channel uses `ThreadHeaderBuilder`.
- `StreamExecutor.updateThreadRoot`:
  - replace current text-only header with builder output.

### 8.2 Action Panel
- New `ActionPanelManager`:
  - `ensurePanel(session)` → posts ephemeral panel in channel root.
  - `updatePanel(session, opts)` → re-renders when state changes.
- `StreamExecutor`:
  - on start: disable panel.
  - on completion: enable panel and set waiting if choice exists.
- `StreamProcessor`:
  - when choice payload exists, pass payload to `ActionPanelManager` to append.
- `ChoiceActionHandler` / `FormActionHandler`:
  - on submit, clear choice from action panel.

### 8.3 Workflow Action Handling
- New action handler for workflow buttons:
  - Build injected text (see section 5.1).
  - Inject into session thread using existing message handler.
  - For `new ...` flows, rely on `/new` command semantics.

### 8.4 Ephemeral Update Strategy
- Action panel is posted via `chat.postEphemeral`.
- Ephemeral messages cannot be updated with `chat.update`; updates are done by **re-posting** on state change.
- When a user clicks a button, `respond({ replace_original: true })` can replace the ephemeral message for that user.
- De-duplication is required to avoid flooding the channel with repeated ephemeral updates.

## 9. Error Handling
- Ephemeral post failures: log and continue (no hard fail).
- If session owner mismatch: respond ephemeral with error (consistent with existing action handlers).

## 10. Test Plan

### 10.1 Unit Tests
- `ThreadHeaderBuilder` output formatting (status colors, text lines).
- `ActionPanelBuilder` button layout and disabled state.
- Choice append behavior (single + multi).

### 10.2 Integration Tests
- Session start → creates header + action panel.
- Stream start/end toggles enabled state.
- UIAskUserQuestion renders in both thread and action panel; submit clears action panel.
- PR review workflow shows fix/approve buttons.
