/**
 * `runAgentStreamFromSdk` transport-mapping tests (epic #1023 P4).
 *
 * The claude-sdk streaming backend maps an SDK message stream to neutral
 * events. These tests pin: (1) order-preserving fan-out (one SDK message can
 * yield several events), (2) per-call mapper state isolation (the direct-usage
 * cost fallback uses the prior assistant model name), and (3) lazy/back-pressure
 * pull semantics (the SDK iterator is advanced only as events are consumed).
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { runAgentStreamFromSdk } from '../claude-code/stream-runner';
import type { AgentStreamEvent } from '../stream-types';

const CALC = (_m: string | undefined, input: number) => input * 0.01;

function sdk(obj: unknown): SDKMessage {
  return obj as SDKMessage;
}

async function collect(stream: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

async function* fromArray(msgs: SDKMessage[]): AsyncGenerator<SDKMessage> {
  for (const m of msgs) yield m;
}

describe('runAgentStreamFromSdk (epic #1023 P4)', () => {
  it('maps a multi-message turn in order, fanning one message into several events', async () => {
    const events = await collect(
      runAgentStreamFromSdk(
        fromArray([
          sdk({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-4-5', tools: ['Bash'] }),
          sdk({
            type: 'assistant',
            message: {
              model: 'claude-sonnet-4-5',
              usage: { input_tokens: 10, output_tokens: 5 },
              content: [{ type: 'text', text: 'hi' }],
            },
          }),
          sdk({
            type: 'result',
            subtype: 'success',
            result: 'hi',
            stop_reason: 'end_turn',
            total_cost_usd: 0.1,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        ]),
        { calculateTokenCost: CALC },
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      'session_start',
      'usage', // per-turn (assistant)
      'assistant_delta',
      'usage', // cumulative (result)
      'result',
    ]);
  });

  it('carries mapper state across messages: direct-usage cost prices the prior assistant model', async () => {
    const events = await collect(
      runAgentStreamFromSdk(
        fromArray([
          sdk({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [] } }),
          sdk({ type: 'result', subtype: 'success', result: 'x', usage: { input_tokens: 50, output_tokens: 5 } }),
        ]),
        { calculateTokenCost: CALC },
      ),
    );
    const usage = events.find((e) => e.type === 'usage' && 'usage' in e && e.usage.inputTokens === 50);
    expect(usage).toMatchObject({
      usage: { costSource: 'calculated', totalCostUsd: 0.5, modelName: 'claude-opus-4-8' },
    });
  });

  it('is lazy: pulls the next SDK message only when the consumer pulls the next event', async () => {
    const pulled: string[] = [];
    async function* tracked(): AsyncGenerator<SDKMessage> {
      pulled.push('a');
      yield sdk({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } });
      pulled.push('b');
      yield sdk({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } });
    }
    const it = runAgentStreamFromSdk(tracked(), { calculateTokenCost: CALC })[Symbol.asyncIterator]();
    expect(pulled).toEqual([]); // nothing pulled before first next()
    await it.next();
    expect(pulled).toEqual(['a']); // first message pulled, second not yet
    await it.next();
    expect(pulled).toEqual(['a', 'b']);
  });

  it('empty stream → no events', async () => {
    expect(await collect(runAgentStreamFromSdk(fromArray([]), { calculateTokenCost: CALC }))).toEqual([]);
  });
});
