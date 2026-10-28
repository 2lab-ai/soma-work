/**
 * Claude SDK `SDKMessage` → neutral `AgentStreamEvent` mapper
 * (ADR 0002 pass 2, epic #1023 P3).
 *
 * This is the SDK-side half of the seam: it reproduces the *extraction* logic
 * that `packages/slack/src/stream-processor.ts` performs on each `SDKMessage`
 * today — but emits neutral `AgentStreamEvent`s instead of driving Slack
 * rendering. The rendering / debounce / directive-parsing / dedupe concerns
 * stay in the P4 `AgentStreamProcessor`; this mapper is pure structure.
 *
 * Faithful-parity notes (each pinned to the current processor behavior):
 *   • assistant: thinking blocks always emit `thought_delta`. If the message
 *     contains any `tool_use` block, text blocks are NOT emitted (the processor
 *     routes such messages through `handleToolUseMessage`, which never renders
 *     text — `stream-processor.ts:774-778`); otherwise text → `assistant_delta`.
 *   • per-turn vs cumulative usage: an assistant message's `message.usage` is a
 *     *per-turn* figure (`stream-processor.ts:752-759`) → emitted as a `usage`
 *     event carrying ONLY the `lastTurn*` fields. The `result` message's usage
 *     is *cumulative* → emitted as a `usage` event with the cumulative fields.
 *     Per the epic, the post-loop merge of the two stays in P4, NOT here.
 *   • result: `stop_reason` maps to `AgentStopReason` (validated against the
 *     same `{end_turn,max_tokens,tool_use,stop_sequence}` set, default
 *     `end_turn` — `stream-processor.ts:1319-1323`); error subtypes populate
 *     `result.error`. `result.finalText` carries `message.result` verbatim (the
 *     `currentMessages.includes` dedupe is a P4 concern).
 *   • usage cost-source: `'sdk'` iff every model's cost came from the SDK
 *     (`sawAnyModel && !anyCalculated`, `:1515`) or `directSdkCost>0` (`:1390`),
 *     else `'calculated'`. `calculateTokenCost` is injected so this stays pure.
 *   • system: `compact_boundary` → a `compact_boundary` event (snake→camel) plus
 *     a `status:'compact_done'` (mirrors `onCompactBoundary` + `onStatusUpdate`,
 *     `:1278-1279`); `status:'compacting'` → `status:'compacting'`; `init` →
 *     `session_start`.
 *
 * Adapter zone: may import the SDK `SDKMessage` type (type-only).
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readUuidList, STEER_SETTLEMENT_SUBTYPE } from '../steer-settlement';
import type { AgentContent, AgentStopReason, AgentStreamEvent, AgentUsage } from '../stream-types';

/**
 * Cost calculator dependency (`calculateTokenCost`, injected by claude-handler)
 * so the mapper is a pure, deterministically-testable function with no
 * cost-provider coupling.
 */
export type CalculateTokenCost = (
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
) => number;

export interface SdkMessageMapperDeps {
  calculateTokenCost: CalculateTokenCost;
  /**
   * The host prices this model itself — the SDK does not know it (an llmux
   * model) and its `costUSD` is its default rate, not the model's price
   * (`metrics/host-pricing.ts`). Absent = the SDK's cost always stands.
   */
  hostPriced?: (model: string) => boolean;
}

export interface SdkMessageMapper {
  /** Map a single SDK message to zero or more neutral events (in emit order). */
  map(message: SDKMessage): AgentStreamEvent[];
}

const VALID_STOP_REASONS: readonly AgentStopReason[] = ['end_turn', 'max_tokens', 'tool_use', 'stop_sequence'];

function mapStopReason(raw: unknown): AgentStopReason {
  return typeof raw === 'string' && (VALID_STOP_REASONS as readonly string[]).includes(raw)
    ? (raw as AgentStopReason)
    : 'end_turn';
}

/** Normalize an SDK tool_result `content` value into neutral `AgentContent[]`. */
function normalizeToolResultContent(content: unknown): AgentContent[] {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    return content.map((block): AgentContent => {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        return { type: 'text', text: String((block as { text?: unknown }).text ?? '') };
      }
      return { type: 'json', value: block };
    });
  }
  return [{ type: 'json', value: content }];
}

/** Phases a `command_lifecycle` frame may report that this seam models 1:1. */
const KNOWN_STEER_PHASES = new Set(['started', 'completed', 'cancelled', 'discarded']);

/**
 * Extract the user-send uuid(s) a frame is stamped with (user steering).
 *
 * The SDK stamps the triggering send's client uuid on the turn's FIRST reply
 * frame (`user_message_uuid`, sdk.d.ts:4611 / :4656). The plural
 * `user_message_uuids` is accepted for producers that coalesce several queued
 * sends into one turn — the singular is all SDK 0.3.251 declares, so the plural
 * is read structurally.
 */
function readSteerUuids(m: Record<string, unknown>): string[] {
  const single = m.user_message_uuid;
  if (typeof single === 'string' && single.length > 0) return [single];
  const many = m.user_message_uuids;
  if (Array.isArray(many)) return many.filter((u): u is string => typeof u === 'string' && u.length > 0);
  return [];
}

/**
 * Build the `started` events for a frame stamped with send uuid(s).
 *
 * `started` is the ONLY phase read off a stamp. The terminal phases come from
 * the host-computed `steer_settlement` frame below: the result's
 * `user_message_uuid` names the send that STARTED the turn, so echoing it as
 * `completed` settled the wrong item and left every actually-steered send
 * hanging (SDK 0.3.251 reports no per-frame consumption signal at all).
 */
function steerStartedEventsFor(m: Record<string, unknown>): AgentStreamEvent[] {
  return readSteerUuids(m).map((uuid) => ({ type: 'steer_lifecycle', uuid, phase: 'started' }) as AgentStreamEvent);
}

/**
 * Map the host's synthetic settlement frame (spec §6 item 6).
 *
 * `ClaudeHandler.streamQuery` computes it at the turn's `result` from
 * `queued_turn_count` + the interrupt receipt and injects it just before that
 * result, so this mapper stays a pure function of the frame stream: `consumed`
 * uuids settle as `completed`, `discarded` ones as `discarded`.
 */
function mapSteerSettlement(m: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = readUuidList(m.consumed).map(
    (uuid) => ({ type: 'steer_lifecycle', uuid, phase: 'completed' }) as AgentStreamEvent,
  );
  for (const uuid of readUuidList(m.discarded)) {
    events.push({ type: 'steer_lifecycle', uuid, phase: 'discarded' });
  }
  return events;
}

/**
 * Map a `command_lifecycle`-shaped system frame (user steering).
 *
 * Duck-typed on purpose: SDK 0.3.284 describes these frames in prose
 * (sdk.d.ts:4547) but declares no type for them, so matching a declared
 * shape is impossible. The frame's OWN `uuid` is deliberately NOT used as the
 * send id — that field identifies the frame, not the message whose lifecycle it
 * reports; reading it would fabricate transitions for uuids the host never sent.
 */
function mapCommandLifecycle(m: Record<string, unknown>): AgentStreamEvent[] {
  const uuid = [m.message_uuid, m.command_uuid, m.user_message_uuid].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  if (!uuid) return [];
  const raw = typeof m.phase === 'string' ? m.phase : typeof m.status === 'string' ? m.status : '';
  const phase = KNOWN_STEER_PHASES.has(raw) ? (raw as 'started' | 'completed' | 'cancelled' | 'discarded') : 'observed';
  return [{ type: 'steer_lifecycle', uuid, phase }];
}

/**
 * Spec 12 §2.1 — the subagent a frame came from: the SDK stamps every frame a
 * subagent produces with the id of the tool call that started it. Absent (no
 * key) on the main agent's frames.
 */
function parentOf(message: unknown): { parentToolUseId?: string } {
  const p = (message as { parent_tool_use_id?: unknown } | undefined)?.parent_tool_use_id;
  return typeof p === 'string' && p.length > 0 ? { parentToolUseId: p } : {};
}

const AGENT_OUTCOME_STATUSES = new Set(['completed', 'async_launched', 'remote_launched']);

/**
 * Spec 12 §2.1 — an `Agent` call's structured outcome (SDK
 * `tool_use_result`): whether it only launched a background run, and the run
 * totals of a completed one. Any other tool's structured output is ignored.
 */
function agentOutcomeOf(message: unknown): {
  agentOutcome?: { status: string; toolUses?: number; durationMs?: number };
} {
  const r = (message as { tool_use_result?: unknown } | undefined)?.tool_use_result;
  if (!r || typeof r !== 'object') return {};
  const o = r as Record<string, unknown>;
  if (typeof o.status !== 'string' || !AGENT_OUTCOME_STATUSES.has(o.status)) return {};
  const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const toolUses = finite(o.totalToolUseCount);
  const durationMs = finite(o.totalDurationMs);
  return {
    agentOutcome: {
      status: o.status,
      ...(toolUses !== undefined ? { toolUses } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
  };
}

/** Spec 12 — the lifecycle fields the agent tree shows (present only when the SDK sent them). */
function lifecycleDetails(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof m.subagent_type === 'string' && m.subagent_type) out.subagentType = m.subagent_type;
  if (typeof m.description === 'string' && m.description) out.description = m.description;
  if (typeof m.is_backgrounded === 'boolean') out.background = m.is_backgrounded;
  const u = m.usage as Record<string, unknown> | undefined;
  if (u && typeof u === 'object') {
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    out.usage = { totalTokens: n(u.total_tokens), toolUses: n(u.tool_uses), durationMs: n(u.duration_ms) };
  }
  if (typeof m.last_tool_name === 'string' && m.last_tool_name) out.lastToolName = m.last_tool_name;
  return out;
}

/** A non-negative finite token count, else 0. */
function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Prompt-side tokens (input + cache read + cache write) of a raw Anthropic `usage` object. */
function promptTokens(u: unknown): number {
  if (!u || typeof u !== 'object') return 0;
  const r = u as Record<string, unknown>;
  return tokenCount(r.input_tokens) + tokenCount(r.cache_read_input_tokens) + tokenCount(r.cache_creation_input_tokens);
}

/**
 * The API call a `stream_event` lane is currently streaming: its message id
 * (for the per-call live-usage key) and whether its `message_start` reported
 * no prompt-side usage (input + cache).
 */
interface StreamLaneState {
  messageId?: string;
  startUsageEmpty: boolean;
  /** The call's last emitted reading — a later delta's null/absent field keeps it. */
  last?: CallReading;
}

/** One call's token reading, as the per-turn usage fields carry it. */
interface CallReading {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Merge a `message_delta` usage into the call's previous reading. Delta
 * counters are cumulative per message and nullable (Anthropic streaming
 * spec): a number replaces the field, null/absent keeps what the call already
 * reported — the same merge the SDK's own MessageStream does.
 */
function mergeCallReading(prev: CallReading | undefined, u: Record<string, unknown>): CallReading {
  const pick = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? tokenCount(v) : fallback;
  return {
    input: pick(u.input_tokens, prev?.input ?? 0),
    output: pick(u.output_tokens, prev?.output ?? 0),
    cacheRead: pick(u.cache_read_input_tokens, prev?.cacheRead ?? 0),
    cacheCreate: pick(u.cache_creation_input_tokens, prev?.cacheCreate ?? 0),
  };
}

export function createSdkMessageMapper(deps: SdkMessageMapperDeps): SdkMessageMapper {
  // Carried across messages so the direct-usage fallback prices the correct
  // model tier when the result message itself does not carry `model`.
  let lastAssistantModelName: string | undefined;
  // One streaming API call per lane: the main agent ('') and each subagent
  // (keyed by the tool call that started it) stream independently, so a
  // subagent's `message_start` must not re-key the main call's delta.
  const streamLanes = new Map<string, StreamLaneState>();

  function mapAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    // Steering ack: the turn's FIRST reply frame carries the triggering send's
    // uuid. Emitted before the content so a queued item flips to `started`
    // before any of that turn's text renders.
    events.push(...steerStartedEventsFor(message as unknown as Record<string, unknown>));
    const inner = message.message as unknown as {
      id?: unknown;
      usage?: Record<string, number>;
      model?: unknown;
      content?: unknown[];
    };
    const parent = parentOf(message);

    if (typeof inner.model === 'string' && inner.model.length > 0) {
      lastAssistantModelName = inner.model;
    }

    // Per-turn usage (NOT cumulative) → lastTurn* fields only.
    //
    // ALL-ZERO usage is dropped: llmux/codex-backed models (gpt-5.6 family)
    // attach a zeroed `usage` object to assistant messages. Forwarding it as
    // `lastTurn* = 0` made the executor overwrite the real context-window
    // state with zeros (`/context` → `0/372k (100% available)`, and the GPT
    // fixed-token auto-compact trigger never fired). A per-turn usage that
    // has no prompt side carries no information — skip the event. With partial
    // messages requested (non-claude models, `build-stream-options.ts`) the
    // call's real reading arrives on its `message_delta` instead
    // (`mapStreamEvent`); without one, downstream falls back to the billing
    // aggregate.
    //
    // The same rule as `mapStreamEvent`: a reading needs a prompt side. Every
    // real call sends a prompt, so a frame with output only (a provider whose
    // `message_start` reports `{input 0, output N}`) says nothing about how
    // full the window is — adopting it would read a 600k context as 1 token.
    const u = inner.usage;
    if (u && promptTokens(u) > 0) {
      const lastTurnInputTokens = u.input_tokens || 0;
      const lastTurnOutputTokens = u.output_tokens || 0;
      const lastTurnCacheReadTokens = u.cache_read_input_tokens || 0;
      const lastTurnCacheCreateTokens = u.cache_creation_input_tokens || 0;
      events.push({
        type: 'usage',
        usage: {
          lastTurnInputTokens,
          lastTurnOutputTokens,
          lastTurnCacheReadTokens,
          lastTurnCacheCreateTokens,
          ...(typeof inner.id === 'string' && inner.id ? { lastTurnMessageId: inner.id } : {}),
        },
        ...parent,
      });
    }

    const content = Array.isArray(inner.content) ? (inner.content as Array<Record<string, unknown>>) : [];
    const hasToolUse = content.some((part) => part.type === 'tool_use');

    // Thinking always emits, regardless of the tool-use branch.
    for (const part of content) {
      if (part.type === 'thinking' && part.thinking) {
        events.push({ type: 'thought_delta', text: String(part.thinking), ...parent });
      }
    }

    if (hasToolUse) {
      // Tool-use branch: emit tool_call for each tool_use block; text dropped
      // (the processor's handleToolUseMessage never renders text).
      for (const part of content) {
        if (part.type === 'tool_use' && part.id && part.name) {
          events.push({
            type: 'tool_call',
            toolCallId: String(part.id),
            name: String(part.name),
            input: part.input,
            ...parent,
          });
        }
      }
    } else {
      // Text branch: each text block → assistant_delta (directive/choice
      // parsing is a P4 concern, applied to the committed buffer).
      for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          events.push({ type: 'assistant_delta', text: part.text, ...parent });
        }
      }
    }

    return events;
  }

  function mapUser(message: Extract<SDKMessage, { type: 'user' }>): AgentStreamEvent[] {
    const inner = message.message as { content?: unknown } | undefined;
    const content = (inner?.content ?? (message as { content?: unknown }).content) as unknown;
    if (!Array.isArray(content)) return [];
    const events: AgentStreamEvent[] = [];
    const parent = parentOf(message);
    const blocks = (content as Array<Record<string, unknown>>).filter((block) => block.type === 'tool_result');
    // The structured outcome belongs to the message's one tool result.
    const outcome = blocks.length === 1 ? agentOutcomeOf(message) : {};
    for (const block of blocks) {
      events.push({
        type: 'tool_result',
        toolCallId: String(block.tool_use_id ?? ''),
        content: normalizeToolResultContent(block.content),
        // Preserve absence: a tool_result without `is_error` maps to
        // `undefined` (not `false`) so downstream ToolFormatter output is
        // byte-identical to the prior SDK-message path.
        isError: typeof block.is_error === 'boolean' ? block.is_error : undefined,
        rawOutput: block.content,
        ...parent,
        ...outcome,
      });
    }
    return events;
  }

  function extractUsage(message: Record<string, unknown>): AgentUsage | undefined {
    // Branch 1: modelUsage (camelCase, per-model billing cumulative).
    const modelUsageMap = message.modelUsage;
    if (modelUsageMap && typeof modelUsageMap === 'object') {
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;
      let totalCost = 0;
      let contextWindow: number | undefined;
      let modelName: string | undefined;
      let anyCalculated = false;
      let sawAnyModel = false;
      const modelBreakdown: NonNullable<AgentUsage['modelBreakdown']> = {};

      for (const [model, raw] of Object.entries(modelUsageMap as Record<string, Record<string, number>>)) {
        if (!raw) continue;
        sawAnyModel = true;
        const input = raw.inputTokens || 0;
        const output = raw.outputTokens || 0;
        const cacheRead = raw.cacheReadInputTokens || 0;
        const cacheCreate = raw.cacheCreationInputTokens || 0;
        const sdkCost = raw.costUSD || 0;
        let cost: number;
        if (sdkCost > 0 && !deps.hostPriced?.(model)) {
          cost = sdkCost;
        } else {
          cost = deps.calculateTokenCost(model, input, output, cacheRead, cacheCreate);
          anyCalculated = true;
        }
        totalInput += input;
        totalOutput += output;
        totalCacheRead += cacheRead;
        totalCacheCreation += cacheCreate;
        totalCost += cost;
        modelBreakdown[model] = {
          inputTokens: input,
          outputTokens: output,
          cacheReadInputTokens: cacheRead,
          cacheCreationInputTokens: cacheCreate,
          costUsd: cost,
        };
        if (raw.contextWindow && typeof raw.contextWindow === 'number') {
          contextWindow = raw.contextWindow;
          modelName = model;
        } else if (!modelName) {
          modelName = model;
        }
      }

      // Multi-model turns (e.g. subagents on a different tier, or a session
      // that switched models): the entry pairing above is arbitrary — prefer
      // the model of the LAST assistant message as the turn's model identity.
      if (lastAssistantModelName && modelBreakdown[lastAssistantModelName]) {
        modelName = lastAssistantModelName;
      }

      return {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheReadInputTokens: totalCacheRead,
        cacheCreationInputTokens: totalCacheCreation,
        totalCostUsd: totalCost,
        costSource: sawAnyModel && !anyCalculated ? 'sdk' : 'calculated',
        contextWindow,
        modelName,
        modelBreakdown: sawAnyModel ? modelBreakdown : undefined,
      };
    }

    // Branch 2: direct usage (snake_case, older API shape).
    const directUsage = message.usage as Record<string, number> | undefined;
    if (directUsage) {
      const directInput = directUsage.input_tokens || 0;
      const directOutput = directUsage.output_tokens || 0;
      const directCacheRead = directUsage.cache_read_input_tokens || 0;
      const directCacheCreate = directUsage.cache_creation_input_tokens || 0;
      const directSdkCost = (message.total_cost_usd as number) || 0;
      const directModel = (message.model as string | undefined) ?? lastAssistantModelName;
      const useSdk = directSdkCost > 0 && !(directModel && deps.hostPriced?.(directModel));
      return {
        inputTokens: directInput,
        outputTokens: directOutput,
        cacheReadInputTokens: directCacheRead,
        cacheCreationInputTokens: directCacheCreate,
        totalCostUsd: useSdk
          ? directSdkCost
          : deps.calculateTokenCost(directModel, directInput, directOutput, directCacheRead, directCacheCreate),
        costSource: useSdk ? 'sdk' : 'calculated',
        modelName: directModel,
      };
    }

    return undefined;
  }

  function mapResult(message: Extract<SDKMessage, { type: 'result' }>): AgentStreamEvent[] {
    const m = message as unknown as Record<string, unknown>;
    const events: AgentStreamEvent[] = [];
    // No steer event here: the result's `user_message_uuid` echoes the send that
    // STARTED the turn, not the ones folded into it, so it cannot settle a
    // steered item. Settlement arrives on the preceding `steer_settlement`
    // frame the handler injects (spec §6 item 6).

    const usage = extractUsage(m);
    if (usage) {
      events.push({ type: 'usage', usage });
    }
    // The turn is over: no call is still streaming, so no later delta may be
    // read against this turn's last `message_start`.
    streamLanes.clear();

    const stopReason = mapStopReason(m.stop_reason);
    const subtype = typeof m.subtype === 'string' ? m.subtype : undefined;
    const isError = m.is_error === true || (typeof subtype === 'string' && subtype.startsWith('error_'));

    if (subtype === 'success' && typeof m.result === 'string') {
      events.push({
        type: 'result',
        stopReason,
        finalText: m.result,
        durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : undefined,
        usage,
      });
    } else if (isError) {
      events.push({
        type: 'result',
        stopReason,
        durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : undefined,
        usage,
        error: {
          subtype: subtype || 'error_during_execution',
          errors: Array.isArray(m.errors) ? (m.errors as string[]) : [],
          numTurns: typeof m.num_turns === 'number' ? m.num_turns : undefined,
        },
      });
    } else {
      events.push({
        type: 'result',
        stopReason,
        durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : undefined,
        usage,
      });
    }

    return events;
  }

  function mapSystem(message: Extract<SDKMessage, { type: 'system' }>): AgentStreamEvent[] {
    const m = message as unknown as Record<string, unknown>;
    const subtype = typeof m.subtype === 'string' ? m.subtype : undefined;

    if (subtype === STEER_SETTLEMENT_SUBTYPE) {
      return mapSteerSettlement(m);
    }

    if (subtype === 'command_lifecycle') {
      return mapCommandLifecycle(m);
    }

    if (subtype === 'compact_boundary') {
      const metadata = (m.compact_metadata ?? {}) as Record<string, unknown>;
      return [
        {
          type: 'compact_boundary',
          metadata: {
            trigger: typeof metadata.trigger === 'string' ? metadata.trigger : undefined,
            preTokens: typeof metadata.pre_tokens === 'number' ? metadata.pre_tokens : undefined,
            postTokens: typeof metadata.post_tokens === 'number' ? metadata.post_tokens : undefined,
            preservedSegment: typeof metadata.preserved_segment === 'string' ? metadata.preserved_segment : undefined,
            raw: m.compact_metadata,
          },
        },
        { type: 'status', status: 'compact_done' },
      ];
    }

    if (subtype === 'status') {
      const status = m.status;
      if (status === 'compacting') {
        return [{ type: 'status', status: 'compacting' }];
      }
      return [];
    }

    if (subtype === 'init') {
      return [
        {
          type: 'session_start',
          sessionId: String(m.session_id ?? ''),
          model: typeof m.model === 'string' ? m.model : undefined,
          tools: Array.isArray(m.tools) ? (m.tools as string[]) : undefined,
        },
      ];
    }

    // Authoritative background-task lifecycle. The SDK emits these `system`
    // messages for EVERY background task (`Bash({run_in_background})` and
    // `Task({run_in_background})`) — this is the real "still running?" signal
    // the resume guard needs. Previously dropped here (fell through to the
    // `return []` below), which is why the harness had to reconstruct it
    // heuristically from spawn-ack text + the model polling output tools.
    if (subtype === 'task_started') {
      const taskId = typeof m.task_id === 'string' ? m.task_id : '';
      if (!taskId) return [];
      return [
        {
          type: 'agent_task_lifecycle',
          phase: 'started',
          taskId,
          toolUseId: typeof m.tool_use_id === 'string' ? m.tool_use_id : undefined,
          taskType: typeof m.task_type === 'string' ? m.task_type : undefined,
          ...lifecycleDetails(m),
        },
      ];
    }

    if (subtype === 'task_progress') {
      const taskId = typeof m.task_id === 'string' ? m.task_id : '';
      if (!taskId) return [];
      return [
        {
          type: 'agent_task_lifecycle',
          phase: 'progress',
          taskId,
          toolUseId: typeof m.tool_use_id === 'string' ? m.tool_use_id : undefined,
          ...lifecycleDetails(m),
          ...(typeof m.summary === 'string' && m.summary ? { summary: m.summary } : {}),
        },
      ];
    }

    if (subtype === 'task_notification') {
      const taskId = typeof m.task_id === 'string' ? m.task_id : '';
      const status = m.status;
      if (!taskId || (status !== 'completed' && status !== 'failed' && status !== 'stopped')) {
        return [];
      }
      return [
        {
          type: 'agent_task_lifecycle',
          phase: 'settled',
          taskId,
          toolUseId: typeof m.tool_use_id === 'string' ? m.tool_use_id : undefined,
          status,
          outputFile: typeof m.output_file === 'string' ? m.output_file : undefined,
          summary: typeof m.summary === 'string' ? m.summary : undefined,
          ...lifecycleDetails(m),
        },
      ];
    }

    // `task_updated` carries a wire-safe patch; a terminal `patch.status`
    // ({completed,failed,killed}) is a fallback settle signal in case a
    // `task_notification` is ever missed. `killed` → neutral `stopped`.
    if (subtype === 'task_updated') {
      const taskId = typeof m.task_id === 'string' ? m.task_id : '';
      const patch = (m.patch ?? {}) as Record<string, unknown>;
      const pStatus = patch.status;
      if (!taskId) return [];
      if (pStatus === 'completed' || pStatus === 'failed' || pStatus === 'killed') {
        return [
          {
            type: 'agent_task_lifecycle',
            phase: 'settled',
            taskId,
            status: pStatus === 'killed' ? 'stopped' : pStatus,
          },
        ];
      }
      return [];
    }

    return [];
  }

  /**
   * Map a partial-message (`stream_event`) frame. Text deltas carry no neutral
   * content (partial rendering is not on this seam); two things are read:
   *
   *   • the steering stamp — with `includePartialMessages` it also rides the
   *     turn's first non-ping stream event (sdk.d.ts SDKPartialAssistantMessage);
   *   • per-call usage for providers whose `message_start` reports none.
   *
   * llmux's non-claude providers (codex: gpt-5.6-sol[1m], gpt-6-astra; grok)
   * stream `message_start.usage = {0, 0}` and put the call's real usage on
   * `message_delta` only (measured 2026-10-27). The pinned SDK copies the
   * `message_start` usage onto every assistant frame, so those frames carry
   * nothing and the harness used to fall back to the turn's billing aggregate —
   * the SUM of every call in the agent loop — as the "current context". The
   * `message_delta` usage is the call's own reading, so it becomes the
   * per-call usage event the assistant frame would have carried.
   *
   * Three guards, each against replacing a full reading with `input 0`:
   *   • the call's `message_start` carried no prompt-side reading — an
   *     Anthropic stream's `message_start` already carries the input/cache
   *     counts, so the assistant frame is that call's source (its
   *     `message_delta` input/cache fields are nullable and not needed);
   *   • a delta without a recorded start is ignored (nothing says the
   *     assistant frame lacked usage);
   *   • the delta must carry a prompt-side reading — every real call has a
   *     prompt, so an output-only delta is not an occupancy reading.
   *
   * Delta counters are cumulative and nullable: a later delta's null/absent
   * field keeps the value the call already reported (`mergeCallReading`).
   */
  function mapStreamEvent(message: SDKMessage): AgentStreamEvent[] {
    const m = message as unknown as Record<string, unknown>;
    const events = steerStartedEventsFor(m);
    const ev = m.event as { type?: unknown; message?: { id?: unknown; usage?: unknown }; usage?: unknown } | undefined;
    if (!ev || typeof ev !== 'object') return events;
    const parent = parentOf(message);
    const lane = parent.parentToolUseId ?? '';

    if (ev.type === 'message_start') {
      const id = ev.message?.id;
      streamLanes.set(lane, {
        messageId: typeof id === 'string' && id.length > 0 ? id : undefined,
        startUsageEmpty: promptTokens(ev.message?.usage) === 0,
      });
      return events;
    }

    if (ev.type === 'message_delta') {
      const state = streamLanes.get(lane);
      if (!state?.startUsageEmpty || !ev.usage || typeof ev.usage !== 'object') return events;
      const reading = mergeCallReading(state.last, ev.usage as Record<string, unknown>);
      if (reading.input + reading.cacheRead + reading.cacheCreate === 0) return events;
      state.last = reading;
      events.push({
        type: 'usage',
        usage: {
          lastTurnInputTokens: reading.input,
          lastTurnOutputTokens: reading.output,
          lastTurnCacheReadTokens: reading.cacheRead,
          lastTurnCacheCreateTokens: reading.cacheCreate,
          ...(state.messageId ? { lastTurnMessageId: state.messageId } : {}),
        },
        ...parent,
      });
    }
    return events;
  }

  return {
    map(message: SDKMessage): AgentStreamEvent[] {
      switch (message.type) {
        case 'assistant':
          return mapAssistant(message as Extract<SDKMessage, { type: 'assistant' }>);
        case 'user':
          return mapUser(message as Extract<SDKMessage, { type: 'user' }>);
        case 'result':
          return mapResult(message as Extract<SDKMessage, { type: 'result' }>);
        case 'system':
          return mapSystem(message as Extract<SDKMessage, { type: 'system' }>);
        case 'stream_event':
          return mapStreamEvent(message);
        default:
          // Every other frame type maps to nothing, but a steering stamp on
          // it is still honoured.
          return steerStartedEventsFor(message as unknown as Record<string, unknown>);
      }
    },
  };
}
