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
import type { AgentContent, AgentStopReason, AgentStreamEvent, AgentUsage } from '../stream-types';

/**
 * Cost calculator dependency — mirrors
 * `streamProcessorProviders.calculateTokenCost`. Injected so the mapper is a
 * pure, deterministically-testable function with no cost-provider coupling.
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

export function createSdkMessageMapper(deps: SdkMessageMapperDeps): SdkMessageMapper {
  // Carried across messages so the direct-usage fallback prices the correct
  // model tier (mirrors `_lastAssistantModelName`, stream-processor.ts:765/1389).
  let lastAssistantModelName: string | undefined;

  function mapAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    const inner = message.message as unknown as {
      usage?: Record<string, number>;
      model?: unknown;
      content?: unknown[];
    };

    if (typeof inner.model === 'string' && inner.model.length > 0) {
      lastAssistantModelName = inner.model;
    }

    // Per-turn usage (NOT cumulative) → lastTurn* fields only.
    const u = inner.usage;
    if (u) {
      events.push({
        type: 'usage',
        usage: {
          lastTurnInputTokens: u.input_tokens || 0,
          lastTurnOutputTokens: u.output_tokens || 0,
          lastTurnCacheReadTokens: u.cache_read_input_tokens || 0,
          lastTurnCacheCreateTokens: u.cache_creation_input_tokens || 0,
        },
      });
    }

    const content = Array.isArray(inner.content) ? (inner.content as Array<Record<string, unknown>>) : [];
    const hasToolUse = content.some((part) => part.type === 'tool_use');

    // Thinking always emits, regardless of the tool-use branch.
    for (const part of content) {
      if (part.type === 'thinking' && part.thinking) {
        events.push({ type: 'thought_delta', text: String(part.thinking) });
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
          });
        }
      }
    } else {
      // Text branch: each text block → assistant_delta (directive/choice
      // parsing is a P4 concern, applied to the committed buffer).
      for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          events.push({ type: 'assistant_delta', text: part.text });
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
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result') {
        events.push({
          type: 'tool_result',
          toolCallId: String(block.tool_use_id ?? ''),
          content: normalizeToolResultContent(block.content),
          // Preserve absence: a tool_result without `is_error` maps to
          // `undefined` (not `false`) so downstream ToolFormatter output is
          // byte-identical to the prior SDK-message path.
          isError: typeof block.is_error === 'boolean' ? block.is_error : undefined,
          rawOutput: block.content,
        });
      }
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

      for (const [model, raw] of Object.entries(modelUsageMap as Record<string, Record<string, number>>)) {
        if (!raw) continue;
        sawAnyModel = true;
        const input = raw.inputTokens || 0;
        const output = raw.outputTokens || 0;
        const cacheRead = raw.cacheReadInputTokens || 0;
        const cacheCreate = raw.cacheCreationInputTokens || 0;
        const sdkCost = raw.costUSD || 0;
        let cost: number;
        if (sdkCost > 0) {
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
        if (raw.contextWindow && typeof raw.contextWindow === 'number') {
          contextWindow = raw.contextWindow;
          modelName = model;
        } else if (!modelName) {
          modelName = model;
        }
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
      const useSdk = directSdkCost > 0;
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

    const usage = extractUsage(m);
    if (usage) {
      events.push({ type: 'usage', usage });
    }

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
        default:
          return [];
      }
    },
  };
}
