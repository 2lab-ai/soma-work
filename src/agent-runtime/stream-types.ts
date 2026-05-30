/**
 * Neutral streaming event union — the seam contract for the agent-runtime
 * port's streaming path (ADR 0002 pass 2, epic #1023 P2).
 *
 * This is the SDK-agnostic vocabulary that `AgentStreamProcessor` (P4) consumes
 * instead of `@anthropic-ai/claude-agent-sdk`'s `SDKMessage`. Two backends map
 * onto it:
 *   • Claude SDK (P3 `sdk-message-to-event.ts`): whole-message output collapses
 *     to a single delta per assistant/thinking block.
 *   • ACP (Track B `acp-update-to-event.ts`): `session/update` token chunks map
 *     directly — deltas are the primitive, which is why this union is
 *     delta-first rather than message-first.
 *
 * STRICT BOUNDARY: this module is part of the SDK-agnostic port surface, so it
 * MUST NOT import anything from `@anthropic-ai/claude-agent-sdk` (not even
 * `import type`). The boundary test in `__tests__/stream-types.boundary.test.ts`
 * enforces this. All shapes below are declared structurally so neither backend's
 * concrete types leak across the seam.
 */

/**
 * Why the turn ended. Superset spanning both backends' stop reasons:
 *   • Claude SDK `result.subtype` → `end_turn` / `error` (and the tool/limit
 *     variants surfaced via stop_reason).
 *   • ACP `StopReason` → `end_turn | max_tokens | max_turn_requests | refusal |
 *     cancelled` (`refusal` maps onto `error`; the rest are 1:1).
 */
export type AgentStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'max_turn_requests'
  | 'cancelled'
  | 'error';

/** Coarse tool taxonomy used for rendering/iconography, backend-independent. */
export type AgentToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

/** Lifecycle status of a single tool call. */
export type AgentToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** A neutral content block carried by tool calls/results. */
export interface AgentContent {
  type: 'text' | 'json';
  text?: string;
  value?: unknown;
}

/**
 * Usage / cost snapshot. Cumulative fields plus the per-turn deltas that today's
 * `StreamProcessor` merges after the message loop (`stream-processor.ts:618-622`)
 * — the `lastTurn*` field names match that code so the P4 processor can carry
 * the same post-loop merge.
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  costSource?: 'sdk' | 'calculated' | 'agent';
  contextWindow?: number;
  modelName?: string;
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  lastTurnCacheReadTokens?: number;
  lastTurnCacheCreateTokens?: number;
}

/**
 * The neutral event union consumed by `AgentStreamProcessor`.
 *
 * Deltas (`assistant_delta` / `thought_delta`) are the primitive: SDK mode emits
 * one large delta per assistant message (→ one flush, byte-identical to today),
 * ACP mode emits many small token deltas (→ debounced by the processor).
 */
export type AgentStreamEvent =
  | { type: 'session_start'; sessionId: string; model?: string; tools?: string[] }
  | { type: 'assistant_delta'; text: string; messageId?: string; blockId?: string }
  | { type: 'thought_delta'; text: string; messageId?: string; blockId?: string }
  | {
      type: 'tool_call';
      toolCallId: string;
      name: string;
      input?: unknown;
      title?: string;
      kind?: AgentToolKind;
      status?: AgentToolStatus;
    }
  | {
      type: 'tool_call_update';
      toolCallId: string;
      status?: AgentToolStatus;
      content?: AgentContent[];
      rawInput?: unknown;
      rawOutput?: unknown;
      isError?: boolean;
    }
  | {
      type: 'tool_result';
      toolCallId: string;
      name?: string;
      content: AgentContent[];
      isError?: boolean;
      rawOutput?: unknown;
    }
  | { type: 'usage'; usage: AgentUsage }
  | {
      type: 'result';
      stopReason: AgentStopReason;
      finalText?: string;
      durationMs?: number;
      usage?: AgentUsage;
      error?: { subtype: string; errors: string[]; numTurns?: number };
    }
  | { type: 'status'; status: 'working' | 'compacting' | 'compact_done' | string }
  | {
      type: 'compact_boundary';
      metadata: {
        trigger?: string;
        preTokens?: number;
        postTokens?: number;
        preservedSegment?: string;
        raw?: unknown;
      };
    }
  | {
      type: 'plan_update';
      entries: Array<{ id?: string; title: string; status?: AgentToolStatus; content?: string }>;
    }
  | { type: 'mode_update'; modeId: string };

/** Convenience: extract a single event variant by its `type` tag. */
export type AgentStreamEventOf<T extends AgentStreamEvent['type']> = Extract<AgentStreamEvent, { type: T }>;
