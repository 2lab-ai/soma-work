/**
 * `steer_lifecycle` observation mapping (user-steering WU1).
 *
 * A steered (mid-turn injected) user message is bound to the turn it triggers
 * by the SDK's `user_message_uuid` stamp — carried on the turn's FIRST reply
 * frame (sdk.d.ts:4611 assistant / sdk.d.ts:4656 partial) and echoed on the
 * `result` (sdk.d.ts:4800 success / :4822 error). This maps those stamps onto
 * a neutral event so the stream processor can move a queued item through
 * started → completed without importing the SDK.
 *
 * `command_lifecycle` is duck-typed on purpose: SDK 0.3.251 documents the frame
 * in prose (sdk.d.ts:3932) but declares NO type for it, so we match structurally
 * and degrade unknown phases to `observed` rather than guessing.
 */

import { describe, expect, it } from 'vitest';
import { createSdkMessageMapper } from '../claude-code/sdk-message-to-event';
import type { AgentStreamEvent } from '../stream-types';

const mapper = () => createSdkMessageMapper({ calculateTokenCost: () => 0 });

function steerEvents(events: AgentStreamEvent[]) {
  return events.filter((e) => e.type === 'steer_lifecycle');
}

describe('steer_lifecycle mapping (user-steering WU1)', () => {
  it('emits started for an assistant frame stamped with user_message_uuid', () => {
    const events = mapper().map({
      type: 'assistant',
      user_message_uuid: 'u-1',
      message: { model: 'claude', content: [{ type: 'text', text: 'hi' }] },
    } as never);

    expect(steerEvents(events)).toEqual([{ type: 'steer_lifecycle', uuid: 'u-1', phase: 'started' }]);
    // Existing assistant mapping is untouched.
    expect(events.some((e) => e.type === 'assistant_delta' && e.text === 'hi')).toBe(true);
  });

  it('emits nothing extra for an unstamped assistant frame', () => {
    const events = mapper().map({
      type: 'assistant',
      message: { model: 'claude', content: [{ type: 'text', text: 'hi' }] },
    } as never);
    expect(steerEvents(events)).toEqual([]);
  });

  it('emits completed for a result frame stamped with user_message_uuid', () => {
    const events = mapper().map({
      type: 'result',
      subtype: 'success',
      result: 'done',
      user_message_uuid: 'u-2',
      duration_ms: 5,
    } as never);

    expect(steerEvents(events)).toEqual([{ type: 'steer_lifecycle', uuid: 'u-2', phase: 'completed' }]);
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });

  it('emits one completed per uuid when the frame carries the plural user_message_uuids', () => {
    const events = mapper().map({
      type: 'result',
      subtype: 'success',
      result: 'done',
      user_message_uuids: ['u-3', 'u-4'],
    } as never);

    expect(steerEvents(events)).toEqual([
      { type: 'steer_lifecycle', uuid: 'u-3', phase: 'completed' },
      { type: 'steer_lifecycle', uuid: 'u-4', phase: 'completed' },
    ]);
  });

  it('maps a command_lifecycle system frame to its declared phase', () => {
    const events = mapper().map({
      type: 'system',
      subtype: 'command_lifecycle',
      message_uuid: 'u-5',
      phase: 'cancelled',
    } as never);

    expect(steerEvents(events)).toEqual([{ type: 'steer_lifecycle', uuid: 'u-5', phase: 'cancelled' }]);
  });

  it('degrades an unknown command_lifecycle phase to observed', () => {
    const events = mapper().map({
      type: 'system',
      subtype: 'command_lifecycle',
      command_uuid: 'u-6',
      status: 'coalesced',
    } as never);

    expect(steerEvents(events)).toEqual([{ type: 'steer_lifecycle', uuid: 'u-6', phase: 'observed' }]);
  });

  it('ignores a command_lifecycle frame with no message uuid (the frame uuid is not the send uuid)', () => {
    const events = mapper().map({
      type: 'system',
      subtype: 'command_lifecycle',
      uuid: 'frame-uuid',
      phase: 'started',
    } as never);
    expect(steerEvents(events)).toEqual([]);
  });

  it('emits started from a partial stream_event stamp (includePartialMessages mode)', () => {
    const events = mapper().map({
      type: 'stream_event',
      user_message_uuid: 'u-7',
      event: { type: 'message_start' },
      parent_tool_use_id: null,
    } as never);

    expect(steerEvents(events)).toEqual([{ type: 'steer_lifecycle', uuid: 'u-7', phase: 'started' }]);
  });
});
