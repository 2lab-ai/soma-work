/**
 * Which `result` frame ends the turn (#257).
 *
 * A resumed session whose previous CLI exited with background agents still
 * running first drains a "previous session's background agents stopped"
 * task-notification and emits a `result` for it BEFORE the host's prompt runs.
 * The host used to treat that first `result` as the end of the turn, close the
 * input channel and stop consuming — the prompt was recorded but never
 * answered. The classifier attributes a result to this turn by the uuid the
 * host stamped on the opening message (echoed as `user_message_uuid`).
 *
 * Frame shapes are the ones captured from SDK 0.3.284 (orphan drain and an
 * opening `/compact`).
 */

import { describe, expect, it } from 'vitest';
import { classifyTurnResult, isTurnProgressFrame } from '../turn-result-attribution';

const OPENING = 'opening-uuid';

function success(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'result', subtype: 'success', is_error: false, result: '', ...overrides };
}

describe('classifyTurnResult (#257)', () => {
  it('is terminal for an error result, even without any uuid', () => {
    const verdict = classifyTurnResult(
      { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0 },
      OPENING,
      [],
    );
    expect(verdict.terminal).toBe(true);
  });

  it('is terminal for a success-subtype result flagged is_error, even with a foreign uuid', () => {
    const verdict = classifyTurnResult(success({ is_error: true, user_message_uuid: 'someone-else' }), OPENING, []);
    expect(verdict.terminal).toBe(true);
  });

  it('is terminal when the result echoes the opening uuid', () => {
    const verdict = classifyTurnResult(success({ num_turns: 1, user_message_uuid: OPENING }), OPENING, []);
    expect(verdict.terminal).toBe(true);
  });

  it('is terminal for an opening /compact (num_turns 0 but the opening uuid is echoed)', () => {
    const verdict = classifyTurnResult(
      success({ num_turns: 0, duration_api_ms: 0, user_message_uuid: OPENING }),
      OPENING,
      [],
    );
    expect(verdict.terminal).toBe(true);
  });

  it('is terminal when the result echoes a uuid pushed into this turn', () => {
    const verdict = classifyTurnResult(success({ num_turns: 1, user_message_uuid: 'u-steer-1' }), OPENING, [
      'u-steer-0',
      'u-steer-1',
    ]);
    expect(verdict.terminal).toBe(true);
  });

  /**
   * The host always stamps the opening uuid and the CLI echoes it on the result
   * that answers it, so a uuid-less result answers something else — whatever
   * `num_turns` says. A drained orphan `completed` notification can make the
   * model run a turn of its own (`num_turns >= 1`, no uuid); ending the turn
   * there would re-create #257.
   */
  it('is NOT terminal for a uuid-less result even when it ran a turn (notification-driven turn)', () => {
    const verdict = classifyTurnResult(success({ num_turns: 1, result: 'bg agent finished' }), OPENING, []);
    expect(verdict.terminal).toBe(false);
    expect(classifyTurnResult(success({ num_turns: 5 }), OPENING, []).terminal).toBe(false);
  });

  it('treats an empty user_message_uuid like an absent one', () => {
    expect(classifyTurnResult(success({ num_turns: 2, user_message_uuid: '' }), OPENING, []).terminal).toBe(false);
    expect(classifyTurnResult(success({ num_turns: 0, user_message_uuid: '' }), OPENING, []).terminal).toBe(false);
  });

  it('is NOT terminal for the orphan background-task drain (num_turns 0, no uuid)', () => {
    const verdict = classifyTurnResult(
      success({ num_turns: 0, duration_api_ms: 0, user_message_uuid: undefined }),
      OPENING,
      [],
    );
    expect(verdict.terminal).toBe(false);
  });

  it('is NOT terminal when num_turns is absent and no uuid is echoed', () => {
    expect(classifyTurnResult(success(), OPENING, []).terminal).toBe(false);
  });

  it('is NOT terminal for a foreign uuid, whatever num_turns says', () => {
    const verdict = classifyTurnResult(success({ num_turns: 3, user_message_uuid: 'someone-else' }), OPENING, [
      'u-steer-1',
    ]);
    expect(verdict.terminal).toBe(false);
  });

  it('names the branch it took', () => {
    const reasons = [
      classifyTurnResult({ subtype: 'error_max_turns', is_error: true }, OPENING, []).reason,
      classifyTurnResult(success({ user_message_uuid: OPENING }), OPENING, []).reason,
      classifyTurnResult(success({ user_message_uuid: 'u-1' }), OPENING, ['u-1']).reason,
      classifyTurnResult(success({ num_turns: 0 }), OPENING, []).reason,
      classifyTurnResult(success({ user_message_uuid: 'x' }), OPENING, []).reason,
    ];
    for (const reason of reasons) expect(reason).toMatch(/\S/);
    expect(new Set(reasons).size).toBe(reasons.length);
    // `num_turns` no longer splits the uuid-less branch.
    expect(classifyTurnResult(success({ num_turns: 1 }), OPENING, []).reason).toBe(
      classifyTurnResult(success({ num_turns: 0 }), OPENING, []).reason,
    );
  });
});

/**
 * Which frames disarm the silence bound after a skipped result. Only a frame
 * that shows a turn running may: a side-band frame (background task progress,
 * a subagent's own messages, rate limits, ...) arrives just as well when the
 * prompt is never answered.
 */
describe('isTurnProgressFrame (#257)', () => {
  const ASSISTANT = { type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }] } };
  const USER = { type: 'user', message: { role: 'user', content: [] } };
  const STREAM_EVENT = { type: 'stream_event', event: { type: 'content_block_delta' } };

  it.each([
    ['assistant (no parent_tool_use_id)', ASSISTANT],
    ['assistant (parent_tool_use_id null)', { ...ASSISTANT, parent_tool_use_id: null }],
    ['user (no parent_tool_use_id)', USER],
    ['user (parent_tool_use_id null)', { ...USER, parent_tool_use_id: null }],
    ['stream_event (parent_tool_use_id null)', { ...STREAM_EVENT, parent_tool_use_id: null }],
    ['result', { type: 'result', subtype: 'success', is_error: false }],
    ['system/init', { type: 'system', subtype: 'init', session_id: 'sess-1' }],
  ])('is true for %s', (_kind, frame) => {
    expect(isTurnProgressFrame(frame)).toBe(true);
  });

  it.each([
    ['a subagent assistant frame (parent_tool_use_id set)', { ...ASSISTANT, parent_tool_use_id: 'toolu_bg' }],
    ['a subagent user frame (parent_tool_use_id set)', { ...USER, parent_tool_use_id: 'toolu_bg' }],
    ['a subagent stream_event (parent_tool_use_id set)', { ...STREAM_EVENT, parent_tool_use_id: 'toolu_bg' }],
    ['system/task_progress', { type: 'system', subtype: 'task_progress', task_id: 'task-bg' }],
    ['system/task_notification', { type: 'system', subtype: 'task_notification', status: 'stopped' }],
    ['system/background_tasks_changed', { type: 'system', subtype: 'background_tasks_changed' }],
    ['system/status', { type: 'system', subtype: 'status', status: 'compacting' }],
    ['system without a subtype', { type: 'system' }],
    ['rate_limit_event', { type: 'rate_limit_event', rate_limit_info: {} }],
    ['command_lifecycle', { type: 'command_lifecycle' }],
    ['an unknown type', { type: 'something_new', subtype: 'init' }],
    ['a frame without a type', { subtype: 'init' }],
  ])('is false for %s', (_kind, frame) => {
    expect(isTurnProgressFrame(frame)).toBe(false);
  });
});
