/**
 * sol[1m] context miscalculation (2026-10-27) — per-call usage for llmux
 * non-claude models.
 *
 * Measured against llmux :3456 with the pinned SDK 0.3.284:
 *   • llmux codex / grok providers send `message_start.usage = {0, 0}`; the
 *     real per-call usage only arrives on `message_delta.usage`.
 *   • the SDK copies `message_start` usage onto every assistant frame, so all
 *     of a `gpt-5.6-sol[1m]` turn's assistant frames carry `{0, 0}`.
 *   • the harness therefore had no per-call reading and fell back to the
 *     turn's billing aggregate — the SUM of every API call — as the "current
 *     context". A 3-call probe turn read 50,377 tokens against a real
 *     occupancy of 16,555 (3.04×); a 20-call turn would overstate ~20× [estimate], pin the
 *     display at 100% and trips the 600k auto-compact trigger.
 *
 * The fix: request partial messages for non-claude models and read the
 * per-call usage off `stream_event` `message_delta` frames.
 *
 * The frames below reproduce the shape of that probe run (`gpt-5.6-sol[1m]`,
 * three API calls: two tool calls and a final text). Values are the measured
 * token counts; ids are synthetic.
 *
 * SSOT mapping: T1 (root cause pinned as a regression), T3 (fix).
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { selectCurrentContextTokens } from '@soma/slack/session-usage-math';
import { AgentStreamProcessor, type StreamContext } from '@soma/slack/stream-processor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelCatalog } from '../../model-catalog';
import type { ConversationSession } from '../../types';
import { type BuildStreamOptionsDeps, buildStreamOptions } from '../claude-code/build-stream-options';
import { createSdkMessageMapper } from '../claude-code/sdk-message-to-event';
import type { AgentStreamEvent } from '../stream-types';

const CALC = () => 0;

function sdk(obj: unknown): SDKMessage {
  return obj as SDKMessage;
}

const ZERO_START = { input_tokens: 0, output_tokens: 0 };

/** One API call as the pinned SDK streams it with `includePartialMessages`. */
function llmuxCall(
  id: string,
  delta: { input: number; cacheRead: number; output: number },
  content: unknown[],
  parent: string | null = null,
): SDKMessage[] {
  return [
    sdk({
      type: 'stream_event',
      parent_tool_use_id: parent,
      event: { type: 'message_start', message: { id, model: 'gpt-5.6-sol', usage: ZERO_START } },
    }),
    sdk({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { id, model: 'gpt-5.6-sol', usage: ZERO_START, content },
    }),
    sdk({
      type: 'stream_event',
      parent_tool_use_id: parent,
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: delta.cacheRead,
          input_tokens: delta.input,
          output_tokens: delta.output,
        },
      },
    }),
    sdk({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_stop' } }),
  ];
}

/** The measured 3-call sol[1m] turn. */
const SOL_1M_TURN: SDKMessage[] = [
  ...llmuxCall('resp_1', { input: 94, cacheRead: 16_384, output: 24 }, [
    { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'echo hi' } },
  ]),
  sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hi' }] } }),
  ...llmuxCall('resp_2', { input: 130, cacheRead: 16_384, output: 24 }, [
    { type: 'tool_use', id: 'call_2', name: 'Bash', input: { command: 'echo there' } },
  ]),
  sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'there' }] } }),
  ...llmuxCall('resp_3', { input: 166, cacheRead: 16_384, output: 5 }, [{ type: 'text', text: 'DONE' }]),
  sdk({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'DONE',
    stop_reason: 'end_turn',
    modelUsage: {
      'gpt-5.6-sol[1m]': {
        inputTokens: 1_161,
        outputTokens: 64,
        cacheReadInputTokens: 49_152,
        cacheCreationInputTokens: 0,
        costUSD: 0.07,
        contextWindow: 1_000_000,
      },
    },
  }),
];

/** Real occupancy after the turn: the LAST call's prompt + its output. */
const LAST_CALL_OCCUPANCY = 166 + 16_384 + 5;
/** What the harness reported before the fix: the turn's billing aggregate. */
const AGGREGATE = 1_161 + 49_152 + 64;

function mapAll(messages: SDKMessage[]): AgentStreamEvent[] {
  const mapper = createSdkMessageMapper({ calculateTokenCost: CALC });
  return messages.flatMap((m) => mapper.map(m));
}

function perTurnUsages(events: AgentStreamEvent[]) {
  return events.flatMap((e) =>
    e.type === 'usage' && e.usage.lastTurnInputTokens !== undefined ? [{ ...e.usage, parent: e.parentToolUseId }] : [],
  );
}

describe('llmux per-call usage — mapper (T3)', () => {
  it('a message_delta after an all-zero message_start becomes the per-call usage, with its message id', () => {
    const usages = perTurnUsages(mapAll(SOL_1M_TURN));
    expect(usages).toEqual([
      {
        lastTurnInputTokens: 94,
        lastTurnOutputTokens: 24,
        lastTurnCacheReadTokens: 16_384,
        lastTurnCacheCreateTokens: 0,
        lastTurnMessageId: 'resp_1',
        parent: undefined,
      },
      {
        lastTurnInputTokens: 130,
        lastTurnOutputTokens: 24,
        lastTurnCacheReadTokens: 16_384,
        lastTurnCacheCreateTokens: 0,
        lastTurnMessageId: 'resp_2',
        parent: undefined,
      },
      {
        lastTurnInputTokens: 166,
        lastTurnOutputTokens: 5,
        lastTurnCacheReadTokens: 16_384,
        lastTurnCacheCreateTokens: 0,
        lastTurnMessageId: 'resp_3',
        parent: undefined,
      },
    ]);
  });

  it('claude: a message_start that already carries usage keeps the assistant frame as the only per-call source', () => {
    const start = { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 3 };
    const usages = perTurnUsages(
      mapAll([
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'msg_c', model: 'claude-opus-5-5', usage: start } },
        }),
        sdk({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: 'msg_c', model: 'claude-opus-5-5', usage: start, content: [{ type: 'text', text: 'hi' }] },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          // Anthropic message_delta (input/cache nullable) — must NOT overwrite the
          // assistant frame's reading with input 0.
          event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
        }),
      ]),
    );
    expect(usages).toEqual([
      {
        lastTurnInputTokens: 12,
        lastTurnOutputTokens: 1,
        lastTurnCacheReadTokens: 900,
        lastTurnCacheCreateTokens: 3,
        lastTurnMessageId: 'msg_c',
        parent: undefined,
      },
    ]);
  });

  it('an all-zero message_delta emits nothing', () => {
    const usages = perTurnUsages(
      mapAll([
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'z', usage: ZERO_START } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_delta', usage: { input_tokens: 0, output_tokens: 0 } },
        }),
      ]),
    );
    expect(usages).toEqual([]);
  });

  it('a subagent lane keeps its own message id and is tagged with its parent tool call', () => {
    const events = mapAll([
      ...llmuxCall('resp_main', { input: 50, cacheRead: 1_000, output: 2 }, [
        { type: 'tool_use', id: 'agent_1', name: 'Agent', input: {} },
      ]).slice(0, 1), // main message_start only — its delta arrives after the subagent's
      ...llmuxCall('resp_sub', { input: 7, cacheRead: 300, output: 9 }, [{ type: 'text', text: 'sub' }], 'agent_1'),
      ...llmuxCall('resp_main', { input: 50, cacheRead: 1_000, output: 2 }, [
        { type: 'tool_use', id: 'agent_1', name: 'Agent', input: {} },
      ]).slice(1),
    ]);
    expect(perTurnUsages(events).map((u) => [u.lastTurnMessageId, u.parent, u.lastTurnInputTokens])).toEqual([
      ['resp_sub', 'agent_1', 7],
      ['resp_main', undefined, 50],
    ]);
  });

  it('a message_delta with no recorded message_start emits nothing', () => {
    const usages = perTurnUsages(
      mapAll([
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_delta', usage: { input_tokens: 40, cache_read_input_tokens: 900, output_tokens: 3 } },
        }),
      ]),
    );
    expect(usages).toEqual([]);
  });

  it('an output-only message_delta after an empty message_start is not an occupancy reading', () => {
    const usages = perTurnUsages(
      mapAll([
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'o', usage: ZERO_START } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_delta', usage: { output_tokens: 40 } },
        }),
      ]),
    );
    expect(usages).toEqual([]);
  });

  it('each message_start re-keys its lane (a claude call after an llmux call is not re-read)', () => {
    const usages = perTurnUsages(
      mapAll([
        ...llmuxCall('resp_x', { input: 10, cacheRead: 100, output: 1 }, [{ type: 'text', text: 'a' }]),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'msg_y', usage: { input_tokens: 5, output_tokens: 1 } } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 9 } },
        }),
      ]),
    );
    expect(usages.map((u) => u.lastTurnMessageId)).toEqual(['resp_x']);
  });

  it('#494: a message_start with output only (no prompt-side reading) still counts as empty', () => {
    const usages = perTurnUsages(
      mapAll([
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'p1', usage: { input_tokens: 0, output_tokens: 1 } } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'message_delta',
            usage: { input_tokens: 20, cache_read_input_tokens: 4_000, output_tokens: 9 },
          },
        }),
      ]),
    );
    expect(usages.map((u) => [u.lastTurnMessageId, u.lastTurnInputTokens, u.lastTurnCacheReadTokens])).toEqual([
      ['p1', 20, 4_000],
    ]);
  });

  it('#494: a message_start with no usage key counts as empty', () => {
    const usages = perTurnUsages(
      mapAll([
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'nu' } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_delta', usage: { input_tokens: 3, cache_read_input_tokens: 70, output_tokens: 1 } },
        }),
      ]),
    );
    expect(usages.map((u) => u.lastTurnMessageId)).toEqual(['nu']);
  });

  it('#494: a repeated message_delta replaces the reading for the same message (cumulative snapshot)', () => {
    const usages = perTurnUsages(
      mapAll([
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'rep', usage: ZERO_START } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_delta', usage: { input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 2 } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_delta', usage: { input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 7 } },
        }),
      ]),
    );
    // Both carry the same message id, so the live map keeps one entry (the later
    // one) and the processor's last-call reading is the later snapshot.
    expect(usages.map((u) => [u.lastTurnMessageId, u.lastTurnOutputTokens])).toEqual([
      ['rep', 2],
      ['rep', 7],
    ]);
  });

  it('#494: a CLI retry on the same lane (start, no delta, start, delta) reads the retried call', () => {
    const usages = perTurnUsages(
      mapAll([
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'try1', usage: ZERO_START } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'try2', usage: ZERO_START } },
        }),
        sdk({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_delta', usage: { input_tokens: 5, cache_read_input_tokens: 600, output_tokens: 3 } },
        }),
      ]),
    );
    expect(usages.map((u) => u.lastTurnMessageId)).toEqual(['try2']);
  });

  it('partial content frames never become rendered text — usage extraction only', () => {
    const events = mapAll([
      sdk({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      }),
      sdk({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      }),
      sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } }),
    ]);
    expect(events).toEqual([]);
  });

  it('the steering stamp on a stream event still reports `started`', () => {
    const events = mapAll([
      sdk({
        type: 'stream_event',
        parent_tool_use_id: null,
        user_message_uuid: 'u-1',
        event: { type: 'message_start', message: { id: 'resp_s', usage: ZERO_START } },
      }),
    ]);
    expect(events).toEqual([{ type: 'steer_lifecycle', uuid: 'u-1', phase: 'started' }]);
  });
});

function streamContext(): StreamContext {
  return {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    incidentAttempt: false,
    say: vi.fn().mockResolvedValue({ ts: 'm' }) as unknown as StreamContext['say'],
  };
}

describe('llmux per-call usage — current context after a sol[1m] turn (T1 regression)', () => {
  it('reads the last call, not the sum of every call in the turn', async () => {
    const onUsageUpdate = vi.fn();
    const onLiveUsage = vi.fn();
    async function* stream() {
      for (const e of mapAll(SOL_1M_TURN)) yield e;
    }
    await new AgentStreamProcessor({ onUsageUpdate, onLiveUsage }).process(
      stream() as never,
      streamContext(),
      new AbortController().signal,
    );

    expect(onUsageUpdate).toHaveBeenCalledTimes(1);
    const current = selectCurrentContextTokens(onUsageUpdate.mock.calls[0][0]);
    const used = current.inputTokens + current.cacheReadTokens + current.cacheCreateTokens + current.outputTokens;

    expect(current.source).toBe('per-turn');
    expect(used).toBe(LAST_CALL_OCCUPANCY);
    expect(used).not.toBe(AGGREGATE);
    // The dashboard's live totals see each call as it lands, one per message id.
    expect(onLiveUsage.mock.calls.map(([c]) => c.messageId)).toEqual(['resp_1', 'resp_2', 'resp_3']);
  });

  it("a subagent's call is spent live but never becomes the main agent's occupancy", async () => {
    const onUsageUpdate = vi.fn();
    const onLiveUsage = vi.fn();
    const result = SOL_1M_TURN[SOL_1M_TURN.length - 1];
    const frames: SDKMessage[] = [
      ...SOL_1M_TURN.slice(0, -1),
      // A subagent call AFTER the main agent's last call, with a bigger context.
      ...llmuxCall(
        'resp_sub',
        { input: 900, cacheRead: 80_000, output: 50 },
        [{ type: 'text', text: 'sub' }],
        'agent_1',
      ),
      result,
    ];
    async function* stream() {
      for (const e of mapAll(frames)) yield e;
    }
    await new AgentStreamProcessor({ onUsageUpdate, onLiveUsage }).process(
      stream() as never,
      streamContext(),
      new AbortController().signal,
    );

    const current = selectCurrentContextTokens(onUsageUpdate.mock.calls[0][0]);
    expect(current.inputTokens + current.cacheReadTokens + current.cacheCreateTokens + current.outputTokens).toBe(
      LAST_CALL_OCCUPANCY,
    );
    expect(onLiveUsage.mock.calls[onLiveUsage.mock.calls.length - 1]?.[0]).toMatchObject({
      messageId: 'resp_sub',
      sidechain: true,
    });
  });
});

function makeDeps(): BuildStreamOptionsDeps {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    getEffectivePluginPaths: () => [],
    buildModelCommandContext: () => undefined,
    mcpConfigBuilder: {
      buildConfig: vi.fn(async () => ({
        permissionMode: 'bypassPermissions',
        userBypass: true,
        somaPermissionMode: 'bypass',
        allowDangerouslySkipPermissions: true,
      })),
    },
    compactHookBuilder: undefined,
    promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
  } as unknown as BuildStreamOptionsDeps;
}

describe('llmux per-call usage — partial messages requested only where usage needs them (T3)', () => {
  it.each([
    'gpt-5.6-sol[1m]',
    'gpt-5.6-sol',
    'gpt-6-astra[1m]',
    'grok-4.6',
  ])('%s → includePartialMessages', async (model) => {
    const session = { model, systemPrompt: 'x', sessionId: `s-${model}` } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.includePartialMessages).toBe(true);
  });

  it.each([
    'claude-opus-5-5[1m]',
    'claude-fable-5-1[1m]',
    'claude-sonnet-4-6',
  ])('%s → no partial messages (assistant frames already carry per-call usage)', async (model) => {
    const session = { model, systemPrompt: 'x', sessionId: `s-${model}` } as ConversationSession;
    const { options } = await buildStreamOptions({ queryEnv: {}, session }, makeDeps());
    expect(options.includePartialMessages).toBeUndefined();
  });

  describe('the llmux catalog group decides when it lists the id', () => {
    afterEach(() => modelCatalog.__testReset());

    it('a claude-group entry gets no partial messages; a codex-group entry does', async () => {
      modelCatalog.__testSeed([
        {
          id: 'claude-opus-5-5[1m]',
          aliases: ['opus'],
          name: 'Opus',
          efforts: [],
          max_context: 1_000_000,
          group: 'claude',
        },
        { id: 'gpt-6.1-sol[1m]', aliases: [], name: 'Sol', efforts: [], max_context: 1_000_000, group: 'codex' },
      ]);
      const opts = async (model: string) =>
        (
          await buildStreamOptions(
            { queryEnv: {}, session: { model, systemPrompt: 'x', sessionId: model } as ConversationSession },
            makeDeps(),
          )
        ).options;
      expect((await opts('claude-opus-5-5[1m]')).includePartialMessages).toBeUndefined();
      expect((await opts('gpt-6.1-sol[1m]')).includePartialMessages).toBe(true);
    });

    it('an id the catalog does not list falls back to the claude- prefix', async () => {
      modelCatalog.__testSeed([]);
      const opts = async (model: string) =>
        (
          await buildStreamOptions(
            { queryEnv: {}, session: { model, systemPrompt: 'x', sessionId: model } as ConversationSession },
            makeDeps(),
          )
        ).options;
      expect((await opts('claude-haiku-4-5-20251001')).includePartialMessages).toBeUndefined();
      expect((await opts('gemini-4-argon[1m]')).includePartialMessages).toBe(true);
    });
  });
});
