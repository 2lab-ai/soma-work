# sol[1m] context miscalculation — trace (2026-10-27)

Status: fixed in `fix/llmux-per-call-context-usage`.

## Conclusion

For llmux non-claude models (measured: `gpt-5.6-sol[1m]`, `gpt-6-astra[1m]`, `grok-4.6`) the harness reported the turn's billing spend — every API call of the agent loop added together — as the current context. The per-call reading it relies on arrives as zeros on assistant frames, and the real per-call reading (`message_delta`) was never requested from the SDK.

## Path

Slack thread → `StreamExecutor` → `ClaudeHandler.streamQuery` → Agent SDK 0.3.284 (claude CLI) → llmux `:3456` `/v1/messages` (codex provider) → codex backend.

Back: llmux SSE → SDK assistant frames + `result.modelUsage` → `sdk-message-to-event.ts` → `stream-processor.ts#applyUsageEvent` + post-loop merge → `stream-executor.ts#updateSessionUsage` (`toTurnUsage`, `selectCurrentContextTokens`) → `ConversationSession.usage.current*` (in memory) → `/context` (`context-handler.ts`), thread header (`thread-header-builder.ts`), dashboard (`conversation/dashboard.ts`), auto-compact (`session/compact-threshold-checker.ts`, 600k for sol[1m]).

## Facts

Each fact was checked by a command on 2026-10-27.

1. llmux sends `message_start.usage = {input_tokens: 0, output_tokens: 0}` for `gpt-5.6-sol[1m]`, `gpt-6-astra[1m]` and `grok-4.6`. The real usage is only on `message_delta.usage` (direct SSE probe). Source: llmux `src/provider/responses.rs` hard-codes the zero start.
2. The pinned SDK copies `message_start` usage onto every assistant frame: a three-call `gpt-5.6-sol[1m]` run gave three assistant frames, all `{0, 0}`. `sdk.d.ts` documents assistant-frame usage as not final.
3. The mapper drops all-zero assistant usage, and `selectCurrentContextTokens` then falls back to the turn aggregate (`aggregate-fallback`).
4. The aggregate is the turn's spend: `toTurnUsage` differences the SDK session running total, so it holds every call of the turn (subagent calls included). Probe: input 1,161 + cache read 49,152 + output 64 = 50,377, against a last-call occupancy of 166 + 16,384 + 5 = 16,555 (3.04 times).
5. `includePartialMessages` was not set anywhere in `src/`, so `message_delta` never reached the harness.
6. With `--include-partial-messages` the SDK forwards `stream_event` frames whose `message_delta.usage` is the exact per-call reading (`parent_tool_use_id` is null on the main thread).
7. The window numbers are right and are not the cause: `resolveModelProfile('gpt-5.6-sol[1m]')` is 1,000,000 / 977,000 / 600,000, the SDK reports `contextWindow` 1,000,000 and the llmux catalog lists `maxContext` 1,000,000.
8. A steering stamp may appear on both the first stream event and the first assistant frame. `settleSteeredFollowup` treats `started` as a no-op, so the duplicate is harmless.

Two harness choices turn the missing reading into a wrong action:

- the aggregate fallback is a deliberate policy ("overstating is safer than an empty window"), so missing data became a wrong number rather than no number
- SDK auto-compaction is off (`DISABLE_AUTO_COMPACT=1`), so the harness scheduler is the only compaction authority and the wrong number schedules a real `/compact`

## Hypotheses (not verified)

- The codex backend serves more than 372k input for `sol[1m]`. The catalog says 1M; no request over 372k was sent.
- The SDK's own internal context estimate also reads the zero assistant usage. Not observable from the harness.
- Bare `gpt-5.6-sol`: soma-work uses a 372k window, the llmux catalog lists 272k. A separate question for the bare id.
- Estimate, not measured: a 20-call turn at 200k context reads about 4M, so the display pins at 100% and the 600k trigger fires.

## Fix

- `build-stream-options.ts` requests partial messages when the model's llmux catalog group is not `claude`; an id the catalog does not list falls back to the `claude-` prefix. Claude sessions keep their current wire.
- `sdk-message-to-event.ts` maps `stream_event` frames per lane (main agent, or each subagent by `parent_tool_use_id`). A `message_delta` becomes the call's per-call usage only when that lane's `message_start` carried no usage and the delta carries a prompt-side reading. Lanes clear at the turn's result. Partial content frames still map to nothing.
- Downstream is unchanged: `applyUsageEvent` adopts main-lane readings for occupancy and reports every call (subagents as `sidechain`) as live spend.

## Limits

- A turn cut off before its first `message_delta` still falls back to the aggregate.
- The incident path drops all partial frames, so it does not get this fix.
- Occupancy is adopted at turn end. Live usage during the turn records spend, not occupancy.
- A compact boundary's `post_tokens` still wins over the turn's own sample (issue #196 shield).

## Tests

- `src/agent-runtime/__tests__/llmux-per-call-usage.test.ts` — mapper rules, processor path, option gate
- `src/slack/pipeline/__tests__/llmux-per-call-occupancy.test.ts` — real `StreamExecutor`: the pre-fix wire schedules a needless `/compact`, the fixed wire reads the last call and keeps billing intact
