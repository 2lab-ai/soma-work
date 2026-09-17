/**
 * `steer_lifecycle` observation mapping (user-steering WU1).
 *
 * A steered (mid-turn injected) user message is bound to the turn it triggers
 * by the SDK's `user_message_uuid` stamp — carried on the turn's FIRST reply
 * frame (sdk.d.ts:4611 assistant / sdk.d.ts:4656 partial). That stamp maps to
 * the `started` transition.
 *
 * The terminal transition does NOT come from a stamp: the installed CLI
 * (0.3.251) never reports mid-turn consumption per frame, and the `result`'s
 * `user_message_uuid` only echoes the send that STARTED the turn. Settlement is
 * therefore computed by the host from the result's `queued_turn_count` + the
 * interrupt receipt and handed to this mapper as a synthetic
 * `system/steer_settlement` frame (`claude-handler.ts` streamQuery).
 *
 * `command_lifecycle` is duck-typed on purpose: SDK 0.3.251 documents the frame
 * in prose (sdk.d.ts:3932) but declares NO type for it, so we match structurally
 * and degrade unknown phases to `observed` rather than guessing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSdkMessageMapper } from '../claude-code/sdk-message-to-event';
import { STEER_SETTLEMENT_SUBTYPE } from '../steer-settlement';
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

  it('emits NO steer event for a result frame, even when stamped with user_message_uuid', () => {
    // The result's `user_message_uuid` names the send that STARTED the turn, not
    // the sends folded into it mid-turn — echoing it as `completed` settled the
    // wrong item (and settled nothing for the others). The host-computed
    // `steer_settlement` frame is now the single source of `completed`.
    const events = mapper().map({
      type: 'result',
      subtype: 'success',
      result: 'done',
      user_message_uuid: 'u-2',
      duration_ms: 5,
    } as never);

    expect(steerEvents(events)).toEqual([]);
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });

  it('emits NO steer event for a result frame carrying the plural user_message_uuids', () => {
    const events = mapper().map({
      type: 'result',
      subtype: 'success',
      result: 'done',
      user_message_uuids: ['u-3', 'u-4'],
    } as never);

    expect(steerEvents(events)).toEqual([]);
  });

  it('maps a steer_settlement frame to completed-then-discarded, in list order', () => {
    const events = mapper().map({
      type: 'system',
      subtype: 'steer_settlement',
      consumed: ['u-a', 'u-b'],
      discarded: ['u-c'],
      session_id: 'sess-1',
      uuid: 'frame-uuid',
    } as never);

    expect(events).toEqual([
      { type: 'steer_lifecycle', uuid: 'u-a', phase: 'completed' },
      { type: 'steer_lifecycle', uuid: 'u-b', phase: 'completed' },
      { type: 'steer_lifecycle', uuid: 'u-c', phase: 'discarded' },
    ]);
  });

  it('maps a steer_settlement frame with empty lists to nothing', () => {
    const events = mapper().map({
      type: 'system',
      subtype: 'steer_settlement',
      consumed: [],
      discarded: [],
      session_id: 'sess-1',
      uuid: 'frame-uuid',
    } as never);

    expect(events).toEqual([]);
  });

  it('ignores non-string entries in a steer_settlement frame', () => {
    const events = mapper().map({
      type: 'system',
      subtype: 'steer_settlement',
      consumed: ['u-a', 42, ''],
      discarded: null,
      session_id: 'sess-1',
      uuid: 'frame-uuid',
    } as never);

    expect(events).toEqual([{ type: 'steer_lifecycle', uuid: 'u-a', phase: 'completed' }]);
  });

  it('producer and mapper agree on the settlement subtype literal', () => {
    // The frame is synthetic: `ClaudeHandler` writes the subtype and this
    // mapper matches on it. Two hand-written string literals would drift
    // silently (the settlement would stop mapping and every steered item would
    // hang), so both sides import the same constant — asserted here by mapping
    // a frame whose subtype comes ONLY from the shared constant, and by
    // checking neither producer nor mapper spells the literal by hand.
    const events = mapper().map({
      type: 'system',
      subtype: STEER_SETTLEMENT_SUBTYPE,
      consumed: ['u-a'],
      discarded: ['u-b'],
      session_id: 'sess-1',
      uuid: 'frame-uuid',
    } as never);

    expect(events).toEqual([
      { type: 'steer_lifecycle', uuid: 'u-a', phase: 'completed' },
      { type: 'steer_lifecycle', uuid: 'u-b', phase: 'discarded' },
    ]);

    const producer = fs.readFileSync(path.join(__dirname, '..', '..', 'claude-handler.ts'), 'utf8');
    const consumer = fs.readFileSync(path.join(__dirname, '..', 'claude-code', 'sdk-message-to-event.ts'), 'utf8');
    for (const src of [producer, consumer]) {
      expect(src).toContain('STEER_SETTLEMENT_SUBTYPE');
      expect(src).not.toContain("'steer_settlement'");
    }
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
