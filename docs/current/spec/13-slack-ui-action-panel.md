# Slack session surface — header, status rail and controls

## Version

- Last updated: 27 October 2026
- Scope: the one Slack message at the top of a session thread (the "surface")
- Source files:
  - `packages/slack/src/thread-surface.ts` — composes and renders the surface (`buildCombinedBlocks`, `buildClosedBlocks`)
  - `packages/slack/src/thread-header-builder.ts` — header rows, driven by `config.json` `ui.threadheader`
  - `packages/slack/src/action-panel-builder.ts` — status rail, controls and `ActionPanelBuilder.compose`
  - `src/slack/actions/action-panel-action-handler.ts` — `panel_*` clicks
  - `src/slack/actions/session-action-handler.ts` — close fallback

The February 2026 design (a second, ephemeral "action panel" message in the channel root with workflow buttons) is no longer used. Its history is in `docs/archive/`.

## 1. What the surface shows

One message, top to bottom:

1. The first header row — the title in every preset (`header`, compact `headline` or minimal `context`).
2. The status rail — one full-width `section` (see 2).
3. The remaining header rows, as configured (owner, workflow, model, context gauge, work log, link history).
4. The controls row — `세션 종료`, plus `⏸ 중지` while a turn is running. None when the session is closed.
5. Executive summary blocks, if any, trimmed first when the 50-block budget runs out.

`ActionPanelBuilder.compose(headerBlocks, panelBlocks)` places the rail right after the first non-divider header block and never splits or reorders header blocks. With an empty header the rail comes first. Every path that renders the surface uses it: the live render, the closed render and both close fallbacks.

## 2. Status rail

One `section.text`, never a 2-column `fields` grid (the grid gave the state half the width and wrapped it mid-word).

- Line 1: `{badge} · {step} · {progress age} [· {liveness}]`. The step, real-progress age and liveness are three separate facts (U9/A19); nothing predicts an ETA.
- Line 2: `{turn summary} · {PR state} · 💬 최신 응답 · {verbosity}`. Each part appears only when it exists.
- Line 3, only while a question waits: `❓ 질문에 답변해 주세요 — 질문 보기`.

Closed rail:

- Line 1: `⚫ *종료됨* · MM-DD HH:MM 종료`
- Line 2: `{turn summary} · {PR state} · 💬 최신 응답`

The turn summary is shown verbatim; it is not re-parsed into a grid.

Example (idle `pr-review` session, merged PR):

```
⚪ *사용 가능* · 사용자 액션 대기 · 마지막 활동 5분 전
⏱ 0:09 · 🔀 Merged · 💬 최신 응답 · `minimal`
```

## 3. Glyph and colour rules

- The circles 🟢 🟡 ⚪ ⚫ mean session state and appear only on the badge: 🟢 작업 중 / 요청 처리 중, 🟡 입력 대기, ⚪ 사용 가능 / 대기 중 / 대기, ⚫ 종료됨. Every badge is bold. 🔴 is not used.
- PR and issue states are words: `🔀 Merged`, `🔀 Draft`, `🔀 Closed`, `🔀 Approved · Merge 가능`, `🔀 Approved`, `🔀 Merge 가능`, `🔀 ⚠️ Merge 불가`.
- Kind glyphs, one noun each: 🔀 PR, 🗂 issue, 📄 doc, 📋 work log.
- The log verbosity is a setting, shown as a code chip (`` `minimal` ``, `` `detail` `` and so on).
- In the combined surface the header suppresses its own session-status decorations (`suppressSessionStatus`), so 종료됨 appears once, on the rail. A standalone header marks a closed session with `⚫ _종료됨_` or `_종료됨_`.

## 4. PR state in link rows

A link's stored `status` is the state when the link was last recorded — by a `link` command, a model link directive, or the link-title refresh (#762) re-recording it with fetched metadata. Nothing refreshes it on a timer. The live state comes from the surface's PR cache. The suffix says which one it is:

- live and stored equal, or live only: ` · Merged`
- both, and different: ` · Merged (기록 당시 Open)`
- stored only: ` · 기록 당시 Open`
- neither: no suffix

`ActionPanelBuilder.livePrStatus(link, prStatus)` decides whether a cached status is live: it must have been fetched for the same URL, and the link must not have been re-recorded with another state since the fetch. The rail chip and the link row use the same value. Stored data is never changed by rendering.

## 5. Controls

- `panel_close` (세션 종료, danger, with a confirmation) on every live surface.
- `panel_stop` (⏸ 중지) while a turn is running. It aborts the turn and keeps the session. The thread `!` message and the dashboard stop do the same.
- Both go through one Bolt route, `app.action(/^panel_/)`, and only the session owner can use them.
- The workflow buttons (New Fix, Renew Fix, PR 문서화, New 리뷰, Renew 리뷰, PR 승인, Merge) were removed on 27 October 2026 because nobody used them. A message rendered before that still carries them until its next re-render; a click gets `❌ 지원하지 않는 액션입니다.` and does nothing else.

## 6. Tests

- `packages/slack/src/__tests__/action-panel-builder.layout.test.ts` — rail shape, badges, PR words, verbosity chip, closed rail, `compose`
- `packages/slack/src/__tests__/action-panel-builder.buttons.test.ts` — only `세션 종료` (and `⏸ 중지` while working) render
- `packages/slack/src/__tests__/thread-header-builder.status-words.test.ts` — link suffix by source, markers, suppression
- `packages/slack/src/__tests__/thread-surface.layout.test.ts` — composed message order, single 종료됨, URL and re-record checks
- `src/slack/actions/__tests__/action-panel-action-handler.removed-actions.test.ts` — stale clicks on removed buttons
