/**
 * Neutral streaming event contract — the **consumer-side** declaration that
 * `AgentStreamProcessor` consumes instead of the Claude SDK's `SDKMessage`
 * (ADR 0002 pass 2, epic #1023 P4).
 *
 * WHY A LOCAL COPY: §3.9 contract 1 forbids `packages/slack` from importing
 * `src/agent-runtime` (or the SDK) — the boundary test enforces it. The
 * canonical producer-side definition lives in
 * `src/agent-runtime/stream-types.ts`; this file is its structural twin on the
 * consumer side. TypeScript's structural typing makes the producer's events
 * assignable to this contract at the dependency-injection boundary
 * (`AgentStreamRunnerLike`) without either side importing the other.
 *
 * KEEP IN SYNC with `src/agent-runtime/stream-types.ts`. A structural-compat
 * test in `src/agent-runtime/__tests__/` (which may import both) guards drift.
 */

export type AgentStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'max_turn_requests'
  | 'cancelled'
  | 'error';

export type AgentToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export type AgentToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface AgentContent {
  type: 'text' | 'json';
  text?: string;
  value?: unknown;
}

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

export type AgentStreamEventOf<T extends AgentStreamEvent['type']> = Extract<AgentStreamEvent, { type: T }>;

/**
 * Dependency-injection contract for the streaming backend. App wiring supplies
 * an implementation (which internally calls `src/agent-runtime`'s
 * `runAgentStream` over `ClaudeHandler.streamQuery`); the Slack pipeline depends
 * only on this interface, never on the runtime or the SDK.
 */
export type AgentStreamRunnerLike = (
  prompt: string,
  session?: unknown,
  abortController?: AbortController,
  workingDirectory?: string,
  slackContext?: unknown,
) => AsyncIterable<AgentStreamEvent>;
