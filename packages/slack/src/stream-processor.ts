/**
 * StreamProcessor - Handles Claude SDK message stream processing
 * Extracted from slack-handler.ts for-await loop (Phase 4.1)
 */

import { Logger } from '@soma/common/logger';
import type { AgentStreamEvent, AgentStreamEventOf, AgentUsage } from './agent-stream-types';
import type { SlackMessagePayload } from './choice-message-builder';
import {
  ChannelMessageDirectiveHandler,
  SessionLinkDirectiveHandler,
  SourceWorkingDirDirectiveHandler,
} from './directives';
import { markdownToBlocks, thinkingToQuoteBlock } from './formatters';
// Direct module imports — going through the barrel (`./index`) creates a
// `slack/index.ts → stream-processor.ts → index.ts` cycle that breaks
// tree-shaking and risks init-order issues. See #745.
import { MessageFormatter } from './message-formatter';
import {
  shouldOutput as checkOutputFlag,
  getThinkingRenderMode,
  getToolCallRenderMode,
  LOG_DETAIL,
  OutputFlag,
  verboseTag,
} from './output-flags';
import type { SessionLinks } from './thread-header-builder';
import type { EndTurnInfo } from './thread-surface';
import { ToolFormatter } from './tool-formatter';
import { UserChoiceHandler } from './user-choice-handler';

export interface StreamProcessorProviders {
  calculateTokenCost?: (
    model: string | undefined,
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens: number,
    cacheCreationInputTokens: number,
  ) => number;
}

let streamProcessorProviders: Required<StreamProcessorProviders> = {
  calculateTokenCost: () => 0,
};

export function setStreamProcessorProviders(providers: StreamProcessorProviders): void {
  streamProcessorProviders = {
    ...streamProcessorProviders,
    ...providers,
  };
}

/**
 * Context for stream processing
 */
export interface StreamContext {
  channel: string;
  threadTs: string;
  sessionKey: string;
  sessionId?: string;
  say: SayFunction;
  /** Verbosity bitmask — controls which output types are shown */
  logVerbosity?: number;
  /** Whether thinking output is shown in Slack (independent of verbosity). Default: true */
  showThinking?: boolean;
  /** Bot's Slack user ID (used for skill invocation RPG announcements as `<@BOT_ID>`) */
  botUserId?: string;
  /**
   * Per-turn identifier for the 5-block UI façade (Issue #525, PHASE>=1).
   * Populated by stream-executor as `${sessionKey}:${turnStartTs}`.
   * When unset, callers fall back to the legacy `context.say` path.
   */
  turnId?: string;
  /**
   * ThreadPanel façade instance — carries `appendText()` for the B1 stream.
   * Only present when PHASE>=1; stream-processor gates on this + turnId.
   */
  threadPanel?: ThreadPanelFacade;
}

/**
 * Narrow structural type for the subset of ThreadPanel used by StreamContext.
 * Declared inline to avoid importing the concrete class (prevents a runtime
 * import cycle with thread-panel → turn-surface → config).
 */
export interface ThreadPanelFacade {
  isTurnSurfaceActive(): boolean;
  /** Returns `true` when Slack accepted the chunk; `false` signals "fall back to legacy context.say". */
  appendText(turnId: string, text: string): Promise<boolean>;
}

/**
 * Slack say function type
 */
export type SayFunction = (message: {
  text: string;
  thread_ts: string;
  blocks?: any[];
  attachments?: any[];
}) => Promise<{ ts?: string }>;

/**
 * Handler for assistant text messages
 */
export type AssistantTextHandler = (content: string, context: StreamContext) => Promise<void>;

/**
 * Handler for tool use events
 */
export type ToolUseHandler = (toolUse: ToolUseEvent, context: StreamContext) => Promise<void>;

/**
 * Handler for tool result events
 */
export type ToolResultHandler = (toolResult: ToolResultEvent, context: StreamContext) => Promise<void>;

/**
 * Handler for todo updates
 */
export type TodoUpdateHandler = (input: any, context: StreamContext) => Promise<void>;

/**
 * Handler for final result
 */
export type ResultHandler = (result: string, context: StreamContext) => Promise<void>;

/**
 * Tool use event data
 */
export interface ToolUseEvent {
  id: string;
  name: string;
  input: any;
}

/**
 * Tool result event data
 */
export interface ToolResultEvent {
  toolUseId: string;
  toolName?: string;
  result: any;
  isError?: boolean;
}

/**
 * Pending form data for multi-choice forms
 */
export interface PendingForm {
  formId: string;
  sessionKey: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  questions: any[];
  selections: Record<string, { choiceId: string; label: string }>;
  createdAt: number;
}

/**
 * Usage data extracted from result message
 *
 * IMPORTANT: For agent-loop (agentic) calls, the SDK's top-level modelUsage
 * is a **billing cumulative** across all API round-trips in the loop.
 * To know the actual context-window state, we need the LAST assistant
 * message's per-message usage — that is what `inputTokens`/`outputTokens`
 * represent here after extraction.
 *
 * `contextWindow` comes from SDK's `ModelUsage.contextWindow` field
 * (available since Agent SDK v0.1.x) and reflects the model's true
 * maximum context size (e.g. 1_000_000 for Opus 4.6).
 */
export interface UsageData {
  // --- Billing aggregates (cumulative across all API calls in agent loop) ---
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  /**
   * Provenance of `totalCostUsd`:
   * - 'sdk': every contributing model reported `costUSD > 0` and we used it as-is
   * - 'calculated': at least one model's cost was computed locally via
   *   `calculateTokenCost()` (because the SDK returned 0 or we fell back
   *   to the legacy `message.usage` path).
   *
   * Must be set at the point cost is actually determined. Do NOT
   * reconstruct it downstream from `totalCostUsd > 0` — a computed
   * non-zero cost is indistinguishable from an SDK one without this flag.
   */
  costSource?: 'sdk' | 'calculated';
  /** Model's max context window size from SDK (e.g. 1_000_000). undefined if unavailable. */
  contextWindow?: number;
  /** Model name (e.g. "claude-opus-4-6-20250414") from the SDK usage key */
  modelName?: string;

  // --- Per-turn usage from last assistant message (context window state) ---
  // These reflect the LAST API call's actual token counts, NOT cumulative.
  // Use these for context window calculation (how full is the window right now).
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  lastTurnCacheReadTokens?: number;
  lastTurnCacheCreateTokens?: number;

  // --- Per-model breakdown (for token_usage event) ---
  // Raw model usage map from SDK, preserved before aggregation.
  modelBreakdown?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUsd: number;
    }
  >;
}

export interface FinalResponseFooterParams {
  context: StreamContext;
  usage?: UsageData;
  durationMs?: number;
}

/**
 * Stream processor callbacks
 */
export interface StreamCallbacks {
  onToolUse?: (toolUses: ToolUseEvent[], context: StreamContext) => Promise<void>;
  onToolResult?: (toolResults: ToolResultEvent[], context: StreamContext) => Promise<void>;
  /** Update an existing message in-place (for compact tool call completion) */
  onUpdateMessage?: (channel: string, ts: string, text: string) => Promise<void>;
  onTodoUpdate?: TodoUpdateHandler;
  onStatusUpdate?: (
    status: 'thinking' | 'working' | 'completed' | 'error' | 'cancelled' | 'compacting' | 'compact_done',
  ) => Promise<void>;
  onPendingFormCreate?: (formId: string, form: PendingForm) => void;
  getPendingForm?: (formId: string) => PendingForm | undefined;
  /** Called to invalidate old forms when a new form is created */
  onInvalidateOldForms?: (sessionKey: string, newFormId: string) => Promise<void>;
  /** Called with usage data when stream completes */
  onUsageUpdate?: (usage: UsageData) => void;
  /** Called when model outputs session_links JSON directive */
  onSessionLinksDetected?: (links: SessionLinks, context: StreamContext) => Promise<void>;
  /** Called when model outputs channel_message JSON directive */
  onChannelMessageDetected?: (messageText: string, context: StreamContext) => Promise<void>;
  /** Called when model outputs source_working_dir JSON directive */
  onSourceWorkingDirDetected?: (dirPath: string, context: StreamContext) => Promise<void>;
  /** Called when a user choice UI is rendered */
  onChoiceCreated?: (payload: SlackMessagePayload, context: StreamContext, sourceMessageTs?: string) => Promise<void>;
  /** Called when SDK emits compact_boundary (context was auto-compacted) */
  onCompactBoundary?: (metadata?: Record<string, unknown>) => void;
  /**
   * Authoritative background-task lifecycle (mapped 1:1 from the SDK
   * `task_started` / `task_progress` / `task_notification` system messages).
   * The harness's REAL "is background work still running?" signal — wired to
   * the session-scoped lifecycle tracker so the turn-end resume guard no
   * longer reconstructs it heuristically from spawn-ack text + the model
   * polling deprecated output tools. Must be cheap: a pure tracker-state
   * update with no Slack rendering.
   */
  onAgentTaskLifecycle?: (
    event: AgentStreamEventOf<'agent_task_lifecycle'>,
    context: StreamContext,
  ) => void | Promise<void>;
  /** Called before sending the final assistant message to append footer text */
  buildFinalResponseFooter?: (params: FinalResponseFooterParams) => Promise<string | undefined> | string | undefined;
  /**
   * Called for every SDK message the dispatcher forwards — a "sign of life"
   * signal for stall-detection heuristics. Must be cheap; throws are
   * swallowed by the caller so a callback bug cannot abort the stream loop.
   */
  onSdkActivity?: () => void;
  /**
   * Called when the SDK iterator's `.next()` has not resolved within
   * {@link StreamProcessorOptions.idleTimeoutMs}. Wired by the stream
   * executor to `() => abortController.abort('stall-timeout' satisfies
   * RequestAbortReason)`; `handleError` then surfaces the 🔴 stall card.
   * The processor exits with `aborted: true` immediately after invoking
   * this callback — racing INSIDE the consumption loop is necessary
   * because a hung SDK transport that ignores its own abort signal cannot
   * be unblocked by aborting from outside the pending `.next()`.
   *
   * Trace: docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md §C-1.
   */
  onIdleTimeout?: () => void;
}

/**
 * Default idle window between SDK `.next()` resolutions before
 * {@link StreamCallbacks.onIdleTimeout} fires. **2 hours** — earlier values
 * (10 min in PR #926, 30 min in PR #970) both produced production
 * false-positives:
 *
 *   - 10 min killed legitimate long-running deploys (`user:dev`).
 *   - 30 min killed sessions where the assistant emitted a textual
 *     "waiting for your response" without firing a formal ASK tool —
 *     the SDK iterator was genuinely idle but the turn was healthy
 *     and waiting on the user.
 *
 * 2 h leaves room for a user to take lunch / step away / think while
 * still bounding true hangs (next-day cleanup, not infinite). Operators
 * can override per-environment via `SOMA_STREAM_STALL_TIMEOUT_MS`; `=0`
 * disables entirely.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Bounded best-effort window for `iterator.return()` (§C-7). A wedged SDK
 *  transport must not move the post-result hang from `.next()` to `.return()`. */
export const ITERATOR_RETURN_BOUND_MS = 1000;

/**
 * Env var operators use to tune or disable the idle timeout without a
 * redeploy. `0` disables; invalid/non-finite falls back to the default —
 * a typo'd env var must not silently disable the safety net.
 */
export const IDLE_TIMEOUT_ENV_VAR = 'SOMA_STREAM_STALL_TIMEOUT_MS';

/**
 * Read the configured idle timeout from `process.env`. Operator contract:
 *  - unset → {@link DEFAULT_IDLE_TIMEOUT_MS}
 *  - `0` or any non-positive number → disables the idle timeout
 *  - invalid/non-finite → falls back to {@link DEFAULT_IDLE_TIMEOUT_MS}
 *  - positive integer → that many ms
 */
export function readIdleTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[IDLE_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_TIMEOUT_MS;
  if (parsed <= 0) return 0;
  return Math.floor(parsed);
}

/**
 * Constructor-time options for {@link StreamProcessor}. Kept on a separate
 * object (not on `StreamCallbacks`) because these are processor-wide knobs,
 * not per-event callbacks.
 */
export interface StreamProcessorOptions {
  /**
   * Maximum gap (ms) between SDK `.next()` resolutions before
   * {@link StreamCallbacks.onIdleTimeout} fires and the loop returns with
   * `aborted: true`. `<= 0` disables. Default `0` so existing callers
   * (mostly tests) opt in explicitly via {@link readIdleTimeoutMs}.
   */
  idleTimeoutMs?: number;
}

/**
 * Stream processing result
 */
export interface StreamResult {
  success: boolean;
  messageCount: number;
  aborted: boolean;
  /** All collected text from the response (for renew pattern detection) */
  collectedText?: string;
  /** Usage data from the result message */
  usage?: UsageData;
  /** Whether the response ended with a user choice/form prompt */
  hasUserChoice?: boolean;
  /** EndTurn 정보 — stop_reason 기반 (Issue #42 S3) */
  endTurnInfo?: EndTurnInfo;
  /** SDK result error details (Issue #122) — subtype + errors[] from SDKResultError */
  sdkResultError?: {
    subtype: string;
    errors: string[];
    numTurns?: number;
  };
}

export type { EndTurnInfo };

/**
 * Single source of truth for the spawn-ack `task_id:` marker. Drift here
 * would either suppress every `endMcpTracking` call (false-positive:
 * leaks running state across turns) or kill the bg progress UI on real
 * spawn-acks (false-negative: regresses #794). `ToolEventProcessor.isBackgroundTaskSpawnAck`
 * reuses the same regex by going through `extractTaskIdFromResult`.
 */
const TASK_ID_RE = /task_id[:\s]+(\S+)/i;

/**
 * Extract `task_id` from a Task tool result.
 *
 * The SDK returns spawn-ack text like
 *   `"Task started in background. output_file: /path task_id: abc123"`
 * either as a top-level string or as a `{ type: 'text', text: ... }` part
 * inside an array result. The array branch gates on `part.type === 'text'`
 * — the SDK also emits `{type:'image', source:{…}}` (and other non-text
 * shapes); without the gate, a future shape with a same-named `text`
 * metadata field could leak a false-positive `task_id` match.
 */
export function extractTaskIdFromResult(result: unknown): string | undefined {
  if (!result) return undefined;

  if (typeof result === 'string') {
    return result.match(TASK_ID_RE)?.[1];
  }

  if (Array.isArray(result)) {
    for (const part of result) {
      const text = textOfPart(part);
      if (text === undefined) continue;
      const match = text.match(TASK_ID_RE);
      if (match) return match[1];
    }
  }

  return undefined;
}

/** Narrow a content-array part to its text payload, gating on the
 *  Anthropic schema's `type === 'text'` discriminant. */
function textOfPart(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  const obj = part as { type?: unknown; text?: unknown } | null | undefined;
  if (obj?.type !== 'text') return undefined;
  return typeof obj.text === 'string' ? obj.text : undefined;
}

/**
 * Coerce a sync or async iterable into an `AsyncIterator`. `for await (… of)`
 * accepts both shapes natively, but the explicit-iterator form used by
 * {@link StreamProcessor.process} (so it can race `.next()` against an
 * idle-timeout) does not. Wrap sync iterators so their `.next()` results
 * are returned via `Promise.resolve` while keeping `iterator.return` /
 * `iterator.throw` reachable for cleanup.
 */
function asyncIteratorOf<T>(stream: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> {
  const asAsync = (stream as AsyncIterable<T>)[Symbol.asyncIterator];
  if (typeof asAsync === 'function') {
    return asAsync.call(stream);
  }
  const inner = (stream as Iterable<T>)[Symbol.iterator]();
  return {
    next() {
      return Promise.resolve(inner.next());
    },
    return(value?: T) {
      return Promise.resolve(inner.return ? inner.return(value) : { value, done: true });
    },
    throw(err?: unknown) {
      return Promise.resolve(inner.throw ? inner.throw(err) : { value: undefined, done: true });
    },
  } as AsyncIterator<T>;
}

/**
 * AgentStreamProcessor handles the for-await loop over the neutral
 * `AgentStreamEvent` stream (epic #1023 P4), replacing the SDK-typed
 * `StreamProcessor`. It drives the unchanged Slack rendering callbacks.
 */
export class AgentStreamProcessor {
  private logger = new Logger('StreamProcessor');
  private callbacks: StreamCallbacks;
  private _hasUserChoice = false;
  /** Maps Task tool_use_id → input (for correlating TaskOutput with original Task) */
  private pendingTaskInputs = new Map<string, any>();
  /** Maps background task_id → original Task input metadata (for TaskOutput display) */
  private backgroundTaskMeta = new Map<string, { name?: string; subagentLabel?: string; promptPreview?: string }>();
  /** Per-turn usage from the last SDKAssistantMessage (BetaMessage.usage) */
  private _lastAssistantTurnUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  } | null = null;
  /**
   * Model name captured from the most recent SDKAssistantMessage
   * (BetaMessage.model). Used by extractUsageData's direct-usage fallback
   * so calculateTokenCost prices the correct tier when the result message
   * itself does not carry `model`.
   */
  private _lastAssistantModelName: string | undefined;
  /** EndTurn info from the result message stop_reason (Issue #42 S3) */
  private _endTurnInfo: EndTurnInfo | undefined;
  /** Last tool name seen in assistant messages (for endTurnInfo.lastToolUse) */
  private _lastToolName: string | undefined;
  /** SDK result error details from SDKResultError (Issue #122) */
  private _sdkResultError: StreamResult['sdkResultError'] | undefined;
  /**
   * Max ms between iterator `.next()` resolutions before
   * {@link StreamCallbacks.onIdleTimeout} fires and the loop returns
   * `aborted: true`. `0` disables — see {@link readIdleTimeoutMs}.
   */
  private readonly idleTimeoutMs: number;

  constructor(callbacks: StreamCallbacks = {}, options: StreamProcessorOptions = {}) {
    this.callbacks = callbacks;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
  }

  /** Check whether a given output flag is enabled for the stream's verbosity */
  private shouldOutput(flag: number, context: StreamContext): boolean {
    return checkOutputFlag(flag, context.logVerbosity ?? LOG_DETAIL);
  }

  /** Returns verbose category tag prefix (empty string when not verbose) */
  private vtag(flag: number, context: StreamContext): string {
    return verboseTag(flag, context.logVerbosity ?? LOG_DETAIL);
  }

  /**
   * Process the neutral `AgentStreamEvent` stream (epic #1023 P4).
   *
   * Replaces the prior SDK-message consumption: per-`SDKMessage` extraction now
   * lives in the agent-runtime mapper, so this loop consumes already-extracted
   * events and drives the unchanged Slack rendering helpers. Delta events
   * (`assistant_delta`/`thought_delta`) and `tool_call`/`tool_result` events are
   * buffered per render group and flushed at a group boundary, so SDK mode
   * (one delta per message) is byte-identical to the old per-message handlers.
   */
  async process(
    stream: AsyncIterable<AgentStreamEvent>,
    context: StreamContext,
    abortSignal: AbortSignal,
  ): Promise<StreamResult> {
    const currentMessages: string[] = [];
    let lastUsage: UsageData | undefined;
    this._hasUserChoice = false;
    // Note: per-turn state fields (_lastAssistantTurnUsage, _lastToolName,
    // _endTurnInfo, _sdkResultError, _lastAssistantModelName) are NOT reset
    // here — stream-executor constructs a fresh AgentStreamProcessor per turn,
    // so they start at their declared initializers (matches the old class).

    // Per-render-group buffers. Only one is ever non-empty at a time: pushing
    // to one flushes the others, so render order (thinking → text|tools) and
    // cross-message grouping match the old per-message handlers exactly.
    const thinkingBuf: string[] = [];
    const textBuf: string[] = [];
    const toolCallBuf: Array<{ type: 'tool_use'; id: string; name: string; input: unknown }> = [];
    const toolResultBuf: Array<{ type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }> = [];

    const flushThinking = async (): Promise<void> => {
      if (thinkingBuf.length === 0) return;
      const joined = thinkingBuf.join('');
      thinkingBuf.length = 0;
      await this.handleThinkingContent([{ type: 'thinking', thinking: joined }], context);
    };
    const flushText = async (): Promise<void> => {
      if (textBuf.length === 0) return;
      const parts = textBuf.map((text) => ({ type: 'text', text }));
      textBuf.length = 0;
      await this.handleTextMessage(parts, context, currentMessages);
    };
    const flushToolCalls = async (): Promise<void> => {
      if (toolCallBuf.length === 0) return;
      const content = toolCallBuf.slice();
      toolCallBuf.length = 0;
      await this.handleToolUseMessage(content, context);
    };
    const flushToolResults = async (): Promise<void> => {
      if (toolResultBuf.length === 0) return;
      const content = toolResultBuf.slice();
      toolResultBuf.length = 0;
      await this.handleToolResultsContent(content, context);
    };
    const flushAll = async (): Promise<void> => {
      await flushThinking();
      await flushText();
      await flushToolCalls();
      await flushToolResults();
    };

    // Drive the iterator manually so each `.next()` can race against the
    // external abort signal AND the idle timeout. A `for await` blocks
    // indefinitely on a hung `.next()` even when the controller is
    // aborted, because the SDK transport doesn't unblock the pending
    // promise — racing INSIDE the loop sidesteps that and lets the
    // executor's catch + handleError surface the 🔴 stall card.
    // Trace: docs/current/plans/turn-end-surface-guarantee/exhaustive-paths.md §C-1.
    //
    // `asyncIteratorOf` adapts sync iterables (tests pass `function*`
    // generators); the explicit-iterator form here does not auto-promote.
    const iterator: AsyncIterator<AgentStreamEvent> = asyncIteratorOf<AgentStreamEvent>(stream);
    try {
      while (true) {
        if (abortSignal.aborted) {
          return { success: true, messageCount: currentMessages.length, aborted: true };
        }

        const step = await this.raceNextStep(iterator, abortSignal);
        if (step.kind === 'done') break;
        if (step.kind === 'aborted') {
          // Mirror the idleTimeout branch: best-effort tell the abandoned
          // iterator we're done so the underlying generator can release
          // any sockets it holds, in case the SDK didn't honor the abort
          // signal on its own. Throws are harmless here.
          await this.tryReturnIterator(iterator, 'abort');
          return { success: true, messageCount: currentMessages.length, aborted: true };
        }
        if (step.kind === 'idleTimeout') {
          // Notify the executor so it can tag the local controller with
          // `'stall-timeout'` (handleError already routes that reason to
          // the Korean stall-timeout Exception card). Swallow throws —
          // the callback must not crash the loop.
          if (this.callbacks.onIdleTimeout) {
            try {
              this.callbacks.onIdleTimeout();
            } catch (err) {
              this.logger.debug('onIdleTimeout callback threw — ignored', {
                error: (err as Error)?.message ?? String(err),
              });
            }
          }
          await this.tryReturnIterator(iterator, 'idle timeout');
          return { success: true, messageCount: currentMessages.length, aborted: true };
        }

        const event = step.value;

        // Fire *before* per-type handlers so the activity clock reflects
        // when the agent emitted the event, not when a slow handler returned.
        // Swallow throws — the clock is a UX heuristic; a handler bug here
        // must not abort the stream loop.
        if (this.callbacks.onSdkActivity) {
          try {
            this.callbacks.onSdkActivity();
          } catch (err) {
            this.logger.debug('onSdkActivity callback threw — ignored', {
              error: (err as Error)?.message ?? String(err),
            });
          }
        }

        this.logger.debug('Received agent stream event', { type: event.type });

        // Delta/tool events buffer per render group (flushing the others first
        // so only one group is pending); everything else flushes all pending
        // groups, then handles the terminal/usage/status event.
        switch (event.type) {
          case 'thought_delta':
            await flushText();
            await flushToolCalls();
            await flushToolResults();
            thinkingBuf.push(event.text);
            break;
          case 'assistant_delta':
            await flushThinking();
            await flushToolCalls();
            await flushToolResults();
            textBuf.push(event.text);
            break;
          case 'tool_call':
            await flushThinking();
            await flushText();
            await flushToolResults();
            this._lastToolName = event.name;
            toolCallBuf.push({ type: 'tool_use', id: event.toolCallId, name: event.name, input: event.input });
            break;
          case 'tool_result':
            await flushThinking();
            await flushText();
            await flushToolCalls();
            toolResultBuf.push({
              type: 'tool_result',
              tool_use_id: event.toolCallId,
              content: event.rawOutput ?? event.content,
              // Preserve absence (undefined, not false) for ToolFormatter parity.
              is_error: event.isError,
            });
            break;
          case 'usage':
            await flushAll();
            lastUsage = this.applyUsageEvent(event.usage, lastUsage);
            break;
          case 'status':
            await flushAll();
            await this.handleStatusEvent(event.status, context);
            break;
          case 'compact_boundary':
            await flushAll();
            // onCompactBoundary only — the mapper emits a separate
            // `status: 'compact_done'` event right after this, which carries the
            // status update (avoids a double onStatusUpdate('compact_done')).
            this.callbacks.onCompactBoundary?.(
              (event.metadata.raw as Record<string, unknown> | undefined) ?? event.metadata,
            );
            break;
          case 'agent_task_lifecycle':
            // Side-band authoritative background-task signal. Does NOT flush the
            // render groups (it produces no Slack output — just a tracker-state
            // update) so an interleaved task_progress can't fragment streaming.
            await this.callbacks.onAgentTaskLifecycle?.(event, context);
            break;
          case 'result': {
            await flushAll();
            // §C-7: `result` is the turn-terminal signal — final output, usage
            // and cost all live on it. Finalize NOW instead of looping back to
            // `.next()`: the underlying transport does not reliably emit a
            // terminal `done` on long turns (prod hang 2026-05-29), and nothing
            // is consumed after `result`. Best-effort bounded close, then break
            // to post-loop finalization.
            lastUsage = await this.handleResultEvent(event, context, currentMessages, lastUsage);
            await this.tryReturnIterator(iterator, 'result');
            break;
          }
          default:
            // session_start (handled by ClaudeHandler), plan_update, mode_update
            // have no SDK-mode rendering today.
            break;
        }
        if (event.type === 'result') break;
      }

      // The stream ended without a terminal `result` (e.g. transport closed) —
      // flush any text/tool groups still buffered so nothing is dropped.
      await flushAll();

      // Merge per-turn usage from the last assistant message into the
      // aggregate UsageData so consumers can distinguish billing totals
      // from actual context window state.
      if (lastUsage && this._lastAssistantTurnUsage) {
        lastUsage.lastTurnInputTokens = this._lastAssistantTurnUsage.inputTokens;
        lastUsage.lastTurnOutputTokens = this._lastAssistantTurnUsage.outputTokens;
        lastUsage.lastTurnCacheReadTokens = this._lastAssistantTurnUsage.cacheReadTokens;
        lastUsage.lastTurnCacheCreateTokens = this._lastAssistantTurnUsage.cacheCreateTokens;
      }

      // Call usage update callback if we have usage data
      if (lastUsage && this.callbacks.onUsageUpdate) {
        this.callbacks.onUsageUpdate(lastUsage);
      }

      return {
        success: true,
        messageCount: currentMessages.length,
        aborted: false,
        collectedText: currentMessages.join('\n'),
        usage: lastUsage,
        hasUserChoice: this._hasUserChoice,
        endTurnInfo: this._endTurnInfo,
        sdkResultError: this._sdkResultError,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return { success: true, messageCount: currentMessages.length, aborted: true };
      }
      throw error;
    }
  }

  /**
   * Race the next iterator step against (a) external abort and (b) idle
   * timeout. Resolves with a discriminated union describing which racer
   * won. Always cleans up the timer and abort listener so a slow handler
   * downstream cannot accidentally trip a stale timer on the next
   * iteration.
   */
  private async raceNextStep(
    iterator: AsyncIterator<AgentStreamEvent>,
    abortSignal: AbortSignal,
  ): Promise<
    { kind: 'value'; value: AgentStreamEvent } | { kind: 'done' } | { kind: 'aborted' } | { kind: 'idleTimeout' }
  > {
    if (abortSignal.aborted) {
      return { kind: 'aborted' };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    try {
      const nextPromise: Promise<{ kind: 'value'; value: AgentStreamEvent } | { kind: 'done' } | { kind: 'aborted' }> =
        iterator
          .next()
          .then((r) => (r.done ? ({ kind: 'done' } as const) : { kind: 'value' as const, value: r.value }))
          // An AbortError thrown by the iterator (SDK honors the abort signal,
          // OR our `iterator.return()` after a timeout) normalizes to the
          // `aborted` outcome — the outer loop returns `aborted: true` from
          // here, matching the pre-Phase-2 behavior where AbortError was
          // caught by the outer try and returned `aborted: true`.
          // Other errors rethrow so the outer try/catch can deal with them
          // (or re-raise to the executor).
          .catch((err: unknown) => {
            if ((err as { name?: string })?.name === 'AbortError') {
              return { kind: 'aborted' as const };
            }
            throw err;
          });

      const racers: Array<
        Promise<
          { kind: 'value'; value: AgentStreamEvent } | { kind: 'done' } | { kind: 'aborted' } | { kind: 'idleTimeout' }
        >
      > = [nextPromise];

      if (this.idleTimeoutMs > 0) {
        racers.push(
          new Promise<{ kind: 'idleTimeout' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'idleTimeout' }), this.idleTimeoutMs);
            // Fail-safe must never keep Node alive at shutdown.
            // `unref` is missing on browser/jsdom timer stubs — optional-call.
            (timer as { unref?: () => void } | undefined)?.unref?.();
          }),
        );
      }

      racers.push(
        new Promise<{ kind: 'aborted' }>((resolve) => {
          if (abortSignal.aborted) {
            resolve({ kind: 'aborted' });
            return;
          }
          abortListener = () => resolve({ kind: 'aborted' });
          abortSignal.addEventListener('abort', abortListener, { once: true });
        }),
      );

      const winner = await Promise.race(racers);
      // If `next()` lost the race (timeout or external abort won), it is
      // still pending in the background. Attach a no-op catch so that a
      // later rejection (e.g. from `iterator.return()` triggering an
      // AbortError on the in-flight call) cannot become an unhandled
      // rejection. The `aborted`-mapped catch above handles the value
      // shape we care about; this is purely defense-in-depth.
      nextPromise.catch(() => undefined);
      return winner;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) abortSignal.removeEventListener('abort', abortListener);
    }
  }

  /**
   * Best-effort `iterator.return()` to release any resources (sockets,
   * generator frames) held by the SDK transport when we abandon the
   * stream early (abort or idle timeout). `reason` is debug-only.
   */
  private async tryReturnIterator(iterator: AsyncIterator<AgentStreamEvent>, reason: string): Promise<void> {
    try {
      const ret = iterator.return?.();
      if (!ret) return;
      // §C-7: bound the close. A wedged transport whose `.return()` never
      // settles must not re-introduce the very hang we just escaped. Lose the
      // race → abandon the cleanup (best-effort; process teardown reclaims it).
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.resolve(ret).then(
          () => undefined,
          (err) => {
            this.logger.debug(`iterator.return() after ${reason} threw — ignored`, {
              error: (err as Error)?.message ?? String(err),
            });
          },
        ),
        new Promise<void>((resolve) => {
          bound = setTimeout(resolve, ITERATOR_RETURN_BOUND_MS);
          (bound as { unref?: () => void } | undefined)?.unref?.();
        }),
      ]).finally(() => {
        if (bound) clearTimeout(bound);
      });
    } catch (err) {
      this.logger.debug(`iterator.return() after ${reason} threw — ignored`, {
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  /**
   * Handle assistant message (text or tool use)
   */
  /**
   * Extract and output thinking/reasoning content from assistant message
   */
  private async handleThinkingContent(content: any[], context: StreamContext): Promise<void> {
    // Respect per-session/user showThinking toggle (independent of verbosity)
    if (context.showThinking === false) return;

    // Issue #525 P1: preserve the B1 single-writer invariant. Thinking is
    // narrative flavor (same category as the RPG skill banner dropped below
    // in handleToolUseMessage) and would render as a second message next to
    // the consolidated stream under PHASE>=1. Suppress entirely until a later
    // phase wires thinking chunks into the B1 stream.
    const inTurn = Boolean(context.turnId && context.threadPanel?.isTurnSurfaceActive());
    if (inTurn) return;

    const thinkingMode = getThinkingRenderMode(context.logVerbosity ?? LOG_DETAIL);
    if (thinkingMode === 'hidden') return;

    const thinkingParts = content
      .filter((part: any) => part.type === 'thinking' && part.thinking)
      .map((part: any) => part.thinking as string);

    if (thinkingParts.length === 0) return;

    const thinkingText = thinkingParts.join('\n\n');
    if (!thinkingText.trim()) return;

    const truncated = this.truncateThinking(thinkingText, thinkingMode);
    if (!truncated) return;

    const tag = this.vtag(OutputFlag.THINKING, context);
    const fallbackText = `${tag}💭 _${truncated}_`;
    await context.say({
      text: fallbackText,
      blocks: [thinkingToQuoteBlock(truncated)],
      thread_ts: context.threadTs,
    });
  }

  /** Truncate thinking output based on render mode */
  private truncateThinking(text: string, mode: 'compact' | 'detail' | 'verbose'): string | null {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    switch (mode) {
      case 'compact':
        return ToolFormatter.truncateString(lines[0], 200);
      case 'detail':
        return ToolFormatter.truncateString(lines.slice(0, 10).join('\n'), 2000);
      case 'verbose':
        return ToolFormatter.truncateString(text, 3000);
    }
  }

  /**
   * Handle tool use in assistant message
   */
  private async handleToolUseMessage(content: any[], context: StreamContext): Promise<void> {
    // Issue #525 P1: when the per-turn façade is active, suppress THIS
    // function's own `context.say` calls (RPG skill banner + tool-call block).
    // B1-fenced tool rendering + B4 status routing land in P2/P4 via the
    // tool-event-processor callback — that path is unchanged and still fires.
    const inTurn = Boolean(context.turnId && context.threadPanel?.isTurnSurfaceActive());

    // Notify status update
    if (this.callbacks.onStatusUpdate) {
      await this.callbacks.onStatusUpdate('working');
    }

    // Check for TodoWrite tool
    const todoTool = content.find((part: any) => part.type === 'tool_use' && part.name === 'TodoWrite');
    if (todoTool && this.callbacks.onTodoUpdate) {
      await this.callbacks.onTodoUpdate(todoTool.input, context);
    }

    // Emit RPG-style skill invocation announcement (PHASE=0 only — flavor text
    // is dropped from the P1 consolidated stream per plan v2 §5.1).
    if (!inTurn && this.shouldOutput(OutputFlag.SKILL_INVOCATION, context)) {
      for (const part of content) {
        if (part.type === 'tool_use' && part.name === 'Skill') {
          const skillName = part.input?.skill || part.input?.name || 'unknown';
          const casterName = context.botUserId ? `<@${context.botUserId}>` : 'AI';
          const rpgMsg = ToolFormatter.formatSkillInvocationRPG(skillName, casterName);
          await context.say({ text: rpgMsg, thread_ts: context.threadTs });
        }
      }
    }

    // Track Task tool inputs for TaskOutput correlation
    for (const part of content) {
      if (part.type === 'tool_use' && part.name === 'Task' && part.id) {
        this.pendingTaskInputs.set(part.id, part.input);
      }
    }

    // Enrich TaskOutput inputs with original Task metadata before formatting
    const enrichedContent = content.map((part: any) => {
      if (part.type === 'tool_use' && part.name === 'TaskOutput') {
        return { ...part, input: this.enrichTaskOutputInput(part.input) };
      }
      return part;
    });

    // Format and send tool use messages (render mode dispatch) — PHASE=0 only.
    const toolCallMode = getToolCallRenderMode(context.logVerbosity ?? LOG_DETAIL);
    if (!inTurn && toolCallMode !== 'hidden') {
      const toolContent = ToolFormatter.formatToolUse(enrichedContent, toolCallMode);
      if (toolContent) {
        const tag = this.vtag(OutputFlag.TOOL_CALL, context);
        await context.say({
          text: tag + toolContent,
          thread_ts: context.threadTs,
        });
      }
    }

    // Collect and notify about tool use events
    const toolUses: ToolUseEvent[] = content
      .filter((part: any) => part.type === 'tool_use' && part.id && part.name)
      .map((part: any) => ({
        id: part.id,
        name: part.name,
        input: part.input,
      }));

    for (const toolUse of toolUses) {
      this.logger.debug(
        'Received tool_use',
        ToolFormatter.buildToolUseLogSummary(toolUse.id, toolUse.name, toolUse.input),
      );
    }

    // Track last tool name for endTurnInfo (Issue #42 S3)
    if (toolUses.length > 0) {
      this._lastToolName = toolUses[toolUses.length - 1].name;
    }

    if (toolUses.length > 0 && this.callbacks.onToolUse) {
      await this.callbacks.onToolUse(toolUses, context);
    }
  }

  /**
   * Extract and dispatch all response directives (session links, channel messages,
   * source working dirs) from text content. Returns the cleaned text with directives stripped.
   */
  private async extractAndDispatchDirectives(text: string, context: StreamContext): Promise<string> {
    let cleaned = text;

    // Each directive handler is isolated — one failure must not block subsequent handlers
    try {
      const linkResult = SessionLinkDirectiveHandler.extract(cleaned);
      if (linkResult.links) {
        cleaned = linkResult.cleanedText;
        if (this.callbacks.onSessionLinksDetected) {
          await this.callbacks.onSessionLinksDetected(linkResult.links, context);
        }
      }
    } catch (error) {
      this.logger.error('Failed to process session link directive', { error });
    }

    try {
      const channelMessageResult = ChannelMessageDirectiveHandler.extract(cleaned);
      if (channelMessageResult.messageText) {
        cleaned = channelMessageResult.cleanedText;
        if (this.callbacks.onChannelMessageDetected) {
          await this.callbacks.onChannelMessageDetected(channelMessageResult.messageText, context);
        }
      }
    } catch (error) {
      this.logger.error('Failed to process channel message directive', { error });
    }

    try {
      const workingDirResult = SourceWorkingDirDirectiveHandler.extract(cleaned);
      if (workingDirResult.path) {
        cleaned = workingDirResult.cleanedText;
        if (this.callbacks.onSourceWorkingDirDetected) {
          await this.callbacks.onSourceWorkingDirDetected(workingDirResult.path, context);
        }
      }
    } catch (error) {
      this.logger.error('Failed to process source working dir directive', { error });
    }

    return cleaned;
  }

  /**
   * Handle text content in assistant message
   */
  private async handleTextMessage(content: any[], context: StreamContext, currentMessages: string[]): Promise<void> {
    let textContent = this.extractTextContent(content);
    if (!textContent) return;

    textContent = await this.extractAndDispatchDirectives(textContent, context);

    if (!textContent.trim()) {
      return;
    }

    currentMessages.push(textContent);

    // Check for user choice JSON
    const { choice, choices, textWithoutChoice } = UserChoiceHandler.extractUserChoice(textContent);

    if (choices) {
      this._hasUserChoice = true;
      await this.handleMultiChoiceMessage(choices, textWithoutChoice, context);
    } else if (choice) {
      this._hasUserChoice = true;
      await this.handleSingleChoiceMessage(choice, textWithoutChoice, context);
    } else {
      // Regular message — convert to Block Kit
      await this.sayWithBlockKit(textContent, context);
    }
  }

  // Max questions per form to stay under Slack's 50-block limit
  // Calculation: 2 (header) + 6 (per question) × N + 3 (submit) ≤ 50 → N ≤ 7
  private static readonly MAX_QUESTIONS_PER_FORM = 6;

  /**
   * Handle multi-question choice form
   * Automatically splits into multiple forms if questions exceed MAX_QUESTIONS_PER_FORM
   */
  private async handleMultiChoiceMessage(
    choices: any,
    textWithoutChoice: string,
    context: StreamContext,
  ): Promise<void> {
    const questions = choices.questions || [];
    const questionCount = questions.length;

    // Log the original model output for debugging
    this.logger.debug('Received multi-choice form from model', {
      questionCount,
      title: choices.title,
      rawChoices: JSON.stringify(choices),
    });

    if (textWithoutChoice) {
      const formatted = MessageFormatter.formatMessage(textWithoutChoice, false);
      await context.say({
        text: formatted,
        thread_ts: context.threadTs,
      });
    }

    // Split questions into chunks if needed
    const chunks: any[][] = [];
    for (let i = 0; i < questionCount; i += AgentStreamProcessor.MAX_QUESTIONS_PER_FORM) {
      chunks.push(questions.slice(i, i + AgentStreamProcessor.MAX_QUESTIONS_PER_FORM));
    }

    if (chunks.length > 1) {
      this.logger.info('Splitting multi-choice form into multiple messages', {
        totalQuestions: questionCount,
        chunkCount: chunks.length,
        questionsPerChunk: chunks.map((c) => c.length),
      });
    }

    // Process each chunk as a separate form
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunkQuestions = chunks[chunkIndex];
      const isFirstChunk = chunkIndex === 0;
      const chunkLabel = chunks.length > 1 ? ` (${chunkIndex + 1}/${chunks.length})` : '';

      const chunkChoices = {
        ...choices,
        title: (choices.title || '선택이 필요합니다') + chunkLabel,
        questions: chunkQuestions,
      };

      await this.sendSingleFormChunk(chunkChoices, context, isFirstChunk);
    }
  }

  /**
   * Send a single form chunk (called by handleMultiChoiceMessage)
   */
  private async sendSingleFormChunk(choices: any, context: StreamContext, invalidateOldForms: boolean): Promise<void> {
    const formId = `form_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Create pending form
    if (this.callbacks.onPendingFormCreate) {
      this.callbacks.onPendingFormCreate(formId, {
        formId,
        sessionKey: context.sessionKey,
        channel: context.channel,
        threadTs: context.threadTs,
        messageTs: '',
        questions: choices.questions,
        selections: {},
        createdAt: Date.now(),
      });
    }

    // Invalidate old forms only for the first chunk
    if (invalidateOldForms && this.callbacks.onInvalidateOldForms) {
      await this.callbacks.onInvalidateOldForms(context.sessionKey, formId);
    }

    // Build and send form
    const multiPayload = UserChoiceHandler.buildMultiChoiceFormBlocks(choices, formId, context.sessionKey);

    // Log block count
    const blockCount = multiPayload.attachments?.[0]?.blocks?.length ?? 0;
    this.logger.debug('Built multi-choice form blocks', {
      formId,
      blockCount,
      questionCount: choices.questions?.length,
    });

    try {
      // Intentionally empty text — attachments carry the rendered content.
      // Setting a text here caused duplicate rendering in Slack
      // (hotfix 53e98054 on deploy/dev). Push notification fallback is
      // preserved via the attachments' fallback field.
      const formResult = await context.say({
        text: '',
        ...multiPayload,
        thread_ts: context.threadTs,
      });

      if (this.callbacks.onChoiceCreated) {
        await this.callbacks.onChoiceCreated(multiPayload, context, formResult?.ts);
      }

      // Update form with message timestamp
      if (this.callbacks.getPendingForm && formResult?.ts) {
        const pendingForm = this.callbacks.getPendingForm(formId);
        if (pendingForm) {
          pendingForm.messageTs = formResult.ts;
        }
      }
    } catch (error: any) {
      this.logger.error('Failed to send multi-choice form to Slack', {
        error: error.message,
        blockCount,
        questionCount: choices.questions?.length,
        rawChoices: JSON.stringify(choices),
      });

      // Fallback: send as plain text instead of throwing
      await this.sendChoiceFallback(choices, context, 'multi');
    }
  }

  /**
   * Handle single choice message
   */
  private async handleSingleChoiceMessage(
    choice: any,
    textWithoutChoice: string,
    context: StreamContext,
  ): Promise<void> {
    // Log the original model output for debugging
    this.logger.debug('Received single choice from model', {
      question: choice.question,
      choiceCount: choice.choices?.length,
      rawChoice: JSON.stringify(choice),
    });

    if (textWithoutChoice) {
      const formatted = MessageFormatter.formatMessage(textWithoutChoice, false);
      await context.say({
        text: formatted,
        thread_ts: context.threadTs,
      });
    }

    const singlePayload = UserChoiceHandler.buildUserChoiceBlocks(choice, context.sessionKey);

    // Log block count
    const blockCount = singlePayload.attachments?.[0]?.blocks?.length ?? 0;
    this.logger.debug('Built single choice blocks', { blockCount });

    try {
      // Intentionally empty text — attachments carry the rendered content.
      // Setting a text here caused duplicate rendering in Slack
      // (hotfix 53e98054 on deploy/dev). Push notification fallback is
      // preserved via the attachments' fallback field.
      const choiceResult = await context.say({
        text: '',
        ...singlePayload,
        thread_ts: context.threadTs,
      });

      if (this.callbacks.onChoiceCreated) {
        await this.callbacks.onChoiceCreated(singlePayload, context, choiceResult?.ts);
      }
    } catch (error: any) {
      this.logger.error('Failed to send single choice to Slack', {
        error: error.message,
        blockCount,
        rawChoice: JSON.stringify(choice),
      });

      // Fallback: send as plain text instead of throwing
      await this.sendChoiceFallback(choice, context, 'single');
    }
  }

  /**
   * Send choice as plain text when Slack blocks fail
   */
  private async sendChoiceFallback(choice: any, context: StreamContext, type: 'single' | 'multi'): Promise<void> {
    this.logger.warn('Sending choice as fallback plain text', { type });

    let fallbackText: string;

    if (type === 'multi') {
      // Multi-choice form fallback
      const questions = choice.questions || [];
      const lines = [
        `📋 *${choice.title || '선택이 필요합니다'}*`,
        choice.description ? `_${choice.description}_` : '',
        '',
        ...questions.map((q: any, idx: number) => {
          const optionsList = (q.choices || [])
            .map(
              (opt: any, optIdx: number) =>
                `  ${optIdx + 1}. ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`,
            )
            .join('\n');
          return `*Q${idx + 1}. ${q.question}*\n${optionsList}`;
        }),
        '',
        '_⚠️ 버튼 UI 생성에 실패하여 텍스트로 표시됩니다. 번호로 응답해주세요._',
        '_예: Q1: 1, Q2: 2, Q3: 1_',
      ];
      fallbackText = lines.filter((l) => l !== '').join('\n');
    } else {
      // Single choice fallback
      const options = (choice.choices || [])
        .map((opt: any, idx: number) => `${idx + 1}. ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`)
        .join('\n');
      fallbackText = [
        `❓ *${choice.question}*`,
        choice.context ? `_${choice.context}_` : '',
        '',
        options,
        '',
        '_⚠️ 버튼 UI 생성에 실패하여 텍스트로 표시됩니다. 번호로 응답해주세요._',
      ]
        .filter((l) => l !== '')
        .join('\n');
    }

    await context.say({
      text: fallbackText,
      thread_ts: context.threadTs,
    });
  }

  /**
   * Handle user message (typically tool results)
   */
  /**
   * Emit tool results to the consumer (epic #1023 P4). Reconstructed from
   * batched `tool_result` events into the SDK tool_result content shape that
   * `ToolFormatter.extractToolResults` already understands, then correlated and
   * forwarded via `onToolResult` — identical to the prior `handleUserMessage`.
   */
  private async handleToolResultsContent(content: any[], context: StreamContext): Promise<void> {
    if (!content || content.length === 0) return;

    const toolResults = ToolFormatter.extractToolResults(content);

    // Correlate Task results with background task IDs for TaskOutput display
    this.correlateTaskResults(toolResults);

    if (toolResults.length > 0 && this.callbacks.onToolResult) {
      await this.callbacks.onToolResult(toolResults, context);
    }
  }

  /**
   * Handle a neutral `status` event. `compacting` surfaces the compacting
   * status; `compact_done` is emitted by the mapper right after a
   * `compact_boundary` (so it carries the status update, keeping the boundary
   * handler to `onCompactBoundary` only — no double status).
   */
  private async handleStatusEvent(status: string, _context: StreamContext): Promise<void> {
    if (status === 'compacting') {
      this.logger.info('Agent context compacting in progress');
      await this.callbacks.onStatusUpdate?.('compacting');
    } else if (status === 'compact_done') {
      await this.callbacks.onStatusUpdate?.('compact_done');
    } else {
      this.logger.debug('Agent status update', { status });
    }
  }

  /**
   * Handle the turn-terminal `result` event (epic #1023 P4). Sets
   * `endTurnInfo` from the stop reason, records any SDK result error, and
   * renders the final text (deduped against text already emitted via deltas).
   * `cumulativeUsage` is the usage already captured from the preceding `usage`
   * event; it is threaded through to the footer and returned for the post-loop
   * `lastTurn*` merge.
   */
  private async handleResultEvent(
    event: Extract<AgentStreamEvent, { type: 'result' }>,
    context: StreamContext,
    currentMessages: string[],
    cumulativeUsage: UsageData | undefined,
  ): Promise<UsageData | undefined> {
    this.logger.info('Received result from agent stream', {
      stopReason: event.stopReason,
      hasResult: typeof event.finalText === 'string',
      isError: !!event.error,
      duration: event.durationMs,
    });

    // Parse stopReason → EndTurnInfo (Issue #42 S3). Clamp to the four reasons
    // the surface understands; anything else (cancelled/error/…) → end_turn.
    const validReasons = ['end_turn', 'max_tokens', 'tool_use', 'stop_sequence'] as const;
    const reason = (validReasons as readonly string[]).includes(event.stopReason)
      ? (event.stopReason as (typeof validReasons)[number])
      : 'end_turn';
    this._endTurnInfo = {
      reason,
      timestamp: Date.now(),
      ...(reason === 'tool_use' && this._lastToolName ? { lastToolUse: this._lastToolName } : {}),
    };

    // Usage normally arrives as a `usage` event just before `result` (→
    // cumulativeUsage). Fall back to the cumulative usage the mapper also
    // attaches to `result.usage` if no preceding usage event set it.
    const usage = cumulativeUsage ?? (event.usage ? this.toUsageData(event.usage) : undefined);

    if (event.error) {
      this.logger.error('Agent result error', {
        subtype: event.error.subtype,
        numTurns: event.error.numTurns,
        errors: event.error.errors,
      });
      this._sdkResultError = {
        subtype: event.error.subtype || 'error_during_execution',
        errors: event.error.errors ?? [],
        numTurns: event.error.numTurns,
      };
    } else if (typeof event.finalText === 'string') {
      const finalResult = event.finalText;
      if (finalResult && !currentMessages.includes(finalResult)) {
        currentMessages.push(finalResult);
        await this.handleFinalResult(finalResult, context, usage, event.durationMs);
      }
    }

    return usage;
  }

  /**
   * Apply a neutral `usage` event. The mapper emits two kinds: a *per-turn*
   * usage (only `lastTurn*` fields) captured for the post-loop merge, and a
   * *cumulative* usage (token/cost fields) that becomes the turn's `UsageData`.
   */
  private applyUsageEvent(u: AgentUsage, current: UsageData | undefined): UsageData | undefined {
    const hasCumulative =
      u.inputTokens !== undefined ||
      u.outputTokens !== undefined ||
      u.totalCostUsd !== undefined ||
      u.cacheReadInputTokens !== undefined ||
      u.cacheCreationInputTokens !== undefined ||
      u.contextWindow !== undefined ||
      u.modelName !== undefined;

    if (hasCumulative) {
      return this.toUsageData(u);
    }

    if (
      u.lastTurnInputTokens !== undefined ||
      u.lastTurnOutputTokens !== undefined ||
      u.lastTurnCacheReadTokens !== undefined ||
      u.lastTurnCacheCreateTokens !== undefined
    ) {
      this._lastAssistantTurnUsage = {
        inputTokens: u.lastTurnInputTokens ?? 0,
        outputTokens: u.lastTurnOutputTokens ?? 0,
        cacheReadTokens: u.lastTurnCacheReadTokens ?? 0,
        cacheCreateTokens: u.lastTurnCacheCreateTokens ?? 0,
      };
    }

    return current;
  }

  /** Map a neutral `AgentUsage` onto the internal `UsageData` shape. */
  private toUsageData(u: AgentUsage): UsageData {
    return {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
      totalCostUsd: u.totalCostUsd ?? 0,
      // The neutral seam carries only 'sdk' | 'calculated' in SDK mode; map the
      // ACP-only 'agent' source onto 'calculated' for internal consumers.
      costSource: u.costSource === 'agent' ? 'calculated' : u.costSource,
      contextWindow: u.contextWindow,
      modelName: u.modelName,
      lastTurnInputTokens: u.lastTurnInputTokens,
      lastTurnOutputTokens: u.lastTurnOutputTokens,
      lastTurnCacheReadTokens: u.lastTurnCacheReadTokens,
      lastTurnCacheCreateTokens: u.lastTurnCacheCreateTokens,
    };
  }

  /**
   * Handle final result text
   */
  private async handleFinalResult(
    result: string,
    context: StreamContext,
    usage?: UsageData,
    durationMs?: number,
  ): Promise<void> {
    // Extract response directives before user choice
    const processedResult = await this.extractAndDispatchDirectives(result, context);

    if (!processedResult.trim()) {
      return;
    }

    let footer: string | undefined;
    if (this.callbacks.buildFinalResponseFooter) {
      footer = await this.callbacks.buildFinalResponseFooter({
        context,
        usage,
        durationMs,
      });
    }

    const combinedResult = footer ? `${processedResult}\n\n${footer}` : processedResult;
    const { choice, choices, textWithoutChoice } = UserChoiceHandler.extractUserChoice(combinedResult);

    if (choices) {
      this._hasUserChoice = true;
      await this.handleMultiChoiceMessage(choices, textWithoutChoice, context);
    } else if (choice) {
      this._hasUserChoice = true;
      await this.handleSingleChoiceMessage(choice, textWithoutChoice, context);
    } else {
      // Final result — convert to Block Kit
      await this.sayWithBlockKit(combinedResult, context);
    }
  }

  /**
   * Send message with Block Kit blocks, with fallback to plain text.
   * Handles overflow messages (content exceeding 45-block limit).
   */
  private async sayWithBlockKit(text: string, context: StreamContext): Promise<void> {
    // Issue #525 P1: PHASE>=1 routes assistant text into the B1 stream via
    // TurnSurface.appendText (chat.appendStream) instead of opening a new
    // Block Kit message per chunk. Verbosity tags are dropped in the stream
    // path — they are legacy noise on a consolidated single-writer surface.
    //
    // Graceful degradation: appendText returns `false` when the B1 stream is
    // not usable (startStream failed, no streamTs, stream already closed).
    // Falling through to the legacy Block Kit path prevents silent response
    // loss on a transient Slack stream-open failure under PHASE>=1.
    if (context.turnId && context.threadPanel?.isTurnSurfaceActive()) {
      const delivered = await context.threadPanel.appendText(context.turnId, text);
      if (delivered) return;
    }

    const tag = this.vtag(OutputFlag.FINAL_RESULT, context);
    const { blocks, fallbackText, overflow } = markdownToBlocks(text);

    try {
      if (blocks.length > 0) {
        await context.say({
          text: tag + fallbackText,
          blocks,
          thread_ts: context.threadTs,
        });

        // Send overflow messages
        for (const overflowBlocks of overflow) {
          await context.say({
            text: '_(continued)_',
            blocks: overflowBlocks,
            thread_ts: context.threadTs,
          });
        }
      } else {
        // No blocks produced — use plain text fallback
        await context.say({
          text: tag + fallbackText,
          thread_ts: context.threadTs,
        });
      }
    } catch (error: any) {
      // Fallback: if Block Kit fails, send as plain text
      const slackError = error?.data?.error;
      const isBlockKitError =
        slackError === 'invalid_blocks' ||
        slackError === 'invalid_attachments' ||
        slackError === 'too_many_blocks' ||
        slackError === 'invalid_blocks_format' ||
        slackError === 'msg_blocks_too_long';

      if (isBlockKitError) {
        this.logger.warn('Block Kit rendering failed, falling back to plain text', {
          slackError,
          error: error.message,
          blockCount: blocks.length,
        });
        const formatted = MessageFormatter.formatMessage(text, true);
        await context.say({
          text: tag + formatted,
          thread_ts: context.threadTs,
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Extract text content from message content array
   */
  private extractTextContent(content: any[]): string | null {
    if (!content) return null;

    const textParts = content.filter((part: any) => part.type === 'text').map((part: any) => part.text);

    return textParts.length > 0 ? textParts.join('') : null;
  }

  /**
   * Correlate Task tool results with background task IDs.
   * When a background Task result returns, it contains the task_id.
   * We store the original Task input metadata keyed by task_id for later TaskOutput use.
   */
  private correlateTaskResults(toolResults: ToolResultEvent[]): void {
    for (const tr of toolResults) {
      const taskInput = this.pendingTaskInputs.get(tr.toolUseId);
      if (!taskInput) continue;

      // Extract task_id from the result text (SDK returns it in the result)
      const taskId = extractTaskIdFromResult(tr.result);
      if (taskId) {
        const summary = ToolFormatter.getTaskToolSummary(taskInput);
        this.backgroundTaskMeta.set(taskId, {
          name: summary.subagentLabel || summary.subagentType,
          subagentLabel: summary.subagentLabel,
          promptPreview: summary.promptPreview,
        });
      }
      this.pendingTaskInputs.delete(tr.toolUseId);
    }
  }

  /**
   * Enrich TaskOutput input with original Task metadata for display.
   * Adds _taskMeta to the input so the formatter can show meaningful info.
   */
  private enrichTaskOutputInput(input: any): any {
    const taskId = input?.task_id;
    if (!taskId) return input;

    const meta = this.backgroundTaskMeta.get(taskId);
    if (!meta) return input;

    return { ...input, _taskMeta: meta };
  }
}
