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
import { classifyTurnResult } from '../turn-result-attribution';

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
