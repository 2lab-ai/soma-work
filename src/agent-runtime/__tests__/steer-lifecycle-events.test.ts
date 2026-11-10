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
 * `command_lifecycle` is duck-typed on purpose: SDK 0.3.284 documents the frame
 * in prose (sdk.d.ts:4547) but declares NO type for it, so we match structurally
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

  /**
   * The frame as the installed CLI really sends it (measured on SDK 0.3.321 / CLI 2.1.321,
   * 2026-11-10): a TOP-LEVEL `type: 'command_lifecycle'` — not a `system` subtype — naming the
   * send in `command_uuid` and its step in `state`. A message pushed into a running turn reports
   * `queued` when the CLI takes it, `started` when it is folded into the turn (the model has it
   * from the next call on) and `completed` when that turn ends. Before this was read, a steered
   * message the model had answered stayed "waiting" until the turn's result (incident 2026-11-10).
   */
  describe('the command_lifecycle frame the CLI sends', () => {
    const frame = (state: string) =>
      ({
        type: 'command_lifecycle',
        command_uuid: 'send-1',
        state,
        uuid: 'frame-uuid',
        session_id: 's1',
      }) as never;

    // Its own phase, not `started`: a `started` also comes from a reply frame's stamp, which the CLI
    // puts on a synthetic API-error message too — a reply that proves no read (review #1178).
    it('maps `started` to read — the CLI handed the message to the model', () => {
      expect(steerEvents(mapper().map(frame('started')))).toEqual([
        { type: 'steer_lifecycle', uuid: 'send-1', phase: 'read' },
      ]);
    });

    it("a reply frame's stamp stays `started` — it is no read receipt", () => {
      const events = mapper().map({
        type: 'assistant',
        user_message_uuid: 'send-1',
        message: { id: 'm1', content: [], usage: {} },
        error: 'authentication_failed',
      } as never);
      expect(steerEvents(events)).toEqual([{ type: 'steer_lifecycle', uuid: 'send-1', phase: 'started' }]);
    });

    it('maps `queued` to observed — taken by the CLI, not read by the model', () => {
      expect(steerEvents(mapper().map(frame('queued')))).toEqual([
        { type: 'steer_lifecycle', uuid: 'send-1', phase: 'observed' },
      ]);
    });

    // The CLI sends `completed` for the message that OPENED the turn too; a consumer reads a
    // `completed` as "this turn folded a steered send in" (#846). The turn's end stays the host's
    // own settlement frame.
    it('maps `completed` to observed — the turn end is the host settlement, not this frame', () => {
      expect(steerEvents(mapper().map(frame('completed')))).toEqual([
        { type: 'steer_lifecycle', uuid: 'send-1', phase: 'observed' },
      ]);
    });

    // A withdrawal is the host's own act (a Cancel, an interrupt's sweep) and it records it itself.
    it('maps `cancelled` to observed — the host that asked for the withdrawal records it', () => {
      expect(steerEvents(mapper().map(frame('cancelled')))).toEqual([
        { type: 'steer_lifecycle', uuid: 'send-1', phase: 'observed' },
      ]);
    });

    it("never reads the frame's own uuid as the send", () => {
      const events = mapper().map({ type: 'command_lifecycle', state: 'started', uuid: 'frame-uuid' } as never);
      expect(steerEvents(events)).toEqual([]);
    });
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
