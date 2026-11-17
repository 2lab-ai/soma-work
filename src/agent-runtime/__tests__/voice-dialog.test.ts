/**
 * .prd/31-phone-calls-architecture.md §3 — the call's dialog reads the Agent SDK's stream. The call loop's tests feed
 * VoiceDialogEvents directly, so this pins the adapter between them: SDK-shaped messages in, events out, in order.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { dialogEventsOf } from '../voice-dialog';

const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;

describe('dialogEventsOf', () => {
  it('a streamed reply: text deltas, the assistant message with its hang_up, the turn end — in that order', () => {
    const stream = [
      sdk({ type: 'stream_event', event: { type: 'message_start', message: {} } }),
      sdk({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '감사합니다.' } },
      }),
      sdk({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"re' } },
      }),
      sdk({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' 안녕히' } },
      }),
      sdk({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5-5',
          content: [
            { type: 'text', text: '감사합니다. 안녕히' },
            { type: 'tool_use', id: 't1', name: 'mcp__phone__hang_up', input: { reason: 'done' } },
          ],
        },
      }),
      sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      sdk({ type: 'result', subtype: 'success', is_error: false }),
    ];
    expect(stream.flatMap(dialogEventsOf)).toEqual([
      { type: 'text_delta', text: '감사합니다.' },
      { type: 'text_delta', text: ' 안녕히' },
      { type: 'assistant', text: '감사합니다. 안녕히', model: 'claude-sonnet-5-5' },
      { type: 'tool_use', name: 'mcp__phone__hang_up', input: { reason: 'done' } },
      { type: 'turn_end', isError: false, message: undefined },
    ]);
  });

  it('a failed turn carries its error text', () => {
    expect(
      dialogEventsOf(
        sdk({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate limited', 42] }),
      ),
    ).toEqual([{ type: 'turn_end', isError: true, message: 'rate limited' }]);
  });

  it('a tool-only assistant message gives only the tool use; other messages give nothing', () => {
    expect(
      dialogEventsOf(
        sdk({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__phone__send_dtmf', input: { digits: '1' } }] },
        }),
      ),
    ).toEqual([{ type: 'tool_use', name: 'mcp__phone__send_dtmf', input: { digits: '1' } }]);
    expect(dialogEventsOf(sdk({ type: 'system', subtype: 'init' }))).toEqual([]);
  });
});
