/**
 * ssot-task: T3 — only an admin may retry a session the safeguards stopped.
 *
 * Two decisions guard the lock:
 *   - `decideSafeguardGate` — applied by `SlackHandler.processMessage` before
 *     anything runs a turn (Slack messages, queue drains, `Send now`,
 *     dashboard sends, host turns).
 *   - `decideSafeguardUnlock` — the admin button on the halt notice, the ONLY
 *     way to lift the lock (trinity design consult: a message is not an
 *     authenticated unlock — host turns and queued messages carry the owner's
 *     id, often an admin's).
 */
import {
  buildSafeguardHaltBlocks,
  decideSafeguardGate,
  decideSafeguardUnlock,
  parseSafeguardButtonValue,
  SAFEGUARD_ADMIN_RETRY_ACTION,
  safeguardRefusalNotice,
  safeguardUnlockedNotice,
} from '@soma/slack/safeguard';
import { describe, expect, it } from 'vitest';

const HALT = { atMs: 1_000, model: 'Opus 5.5 (1M context)', detail: 'reasoning_extraction', requestId: 'req_1' };

describe('decideSafeguardGate (T3)', () => {
  it('passes every turn when the thread is not halted', () => {
    expect(decideSafeguardGate({ halt: undefined, hostTurn: false })).toBe('pass');
    expect(decideSafeguardGate({ halt: undefined, hostTurn: true })).toBe('pass');
  });

  it("refuses a person's message — admin or not, a message never unlocks", () => {
    expect(decideSafeguardGate({ halt: HALT, hostTurn: false })).toBe('refuse');
  });

  it('drops a host turn silently (goal continuation, auto-resume, epic wake, replay)', () => {
    expect(decideSafeguardGate({ halt: HALT, hostTurn: true })).toBe('drop');
  });
});

describe('decideSafeguardUnlock (T3)', () => {
  it('an admin pressing the button of the current halt unlocks', () => {
    expect(decideSafeguardUnlock({ halt: HALT, clickerIsAdmin: true, buttonAtMs: 1_000 })).toBe('unlock');
  });

  it('a non-admin cannot unlock', () => {
    expect(decideSafeguardUnlock({ halt: HALT, clickerIsAdmin: false, buttonAtMs: 1_000 })).toBe('not-admin');
  });

  it("an older notice's button does not lift a newer halt", () => {
    expect(decideSafeguardUnlock({ halt: HALT, clickerIsAdmin: true, buttonAtMs: 999 })).toBe('stale');
  });

  it('nothing to unlock once lifted', () => {
    expect(decideSafeguardUnlock({ halt: undefined, clickerIsAdmin: true, buttonAtMs: 1_000 })).toBe('not-halted');
  });
});

describe('safeguard notices (T3 · T4)', () => {
  it('the halt notice carries the admin button bound to this halt', () => {
    const blocks = buildSafeguardHaltBlocks(HALT, 'C1:T1');
    const button = blocks.flatMap((b: any) => b.elements ?? []).find((e: any) => e.type === 'button');
    expect(button.action_id).toBe(SAFEGUARD_ADMIN_RETRY_ACTION);
    expect(parseSafeguardButtonValue(button.value)).toEqual({ sessionKey: 'C1:T1', atMs: 1_000 });
    expect(blocks[0].text.text).toContain('세이프가드 에러');
  });

  it('a malformed button value is rejected', () => {
    expect(parseSafeguardButtonValue('not json')).toBeNull();
    expect(parseSafeguardButtonValue(JSON.stringify({ sessionKey: 'C1:T1' }))).toBeNull();
  });

  it('the refusal names the safeguard error and the admin requirement', () => {
    const refusal = safeguardRefusalNotice(HALT, { isAdmin: false });
    expect(refusal).toContain('세이프가드 에러');
    expect(refusal).toContain('관리자');
    expect(refusal).toContain('reasoning_extraction');
    expect(safeguardRefusalNotice(HALT, { isAdmin: true })).toContain('관리자 재시도 허용');
    expect(safeguardUnlockedNotice('U_ADMIN')).toContain('<@U_ADMIN>');
  });
});
