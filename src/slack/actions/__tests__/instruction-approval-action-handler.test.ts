import { describe, expect, it, vi } from 'vitest';
import { InstructionApprovalActionHandler } from '../instruction-approval-action-handler';

/**
 * #767 T3 — the owner's DM buttons: the click carries only `{ requestId,
 * decision }`; the clicker is the actor (the store checks they own the
 * session); a refusal is said to the clicker only.
 */

function click(value: unknown, user = 'U_OWNER'): any {
  return {
    user: { id: user },
    actions: [
      { action_id: 'instr_approval_approve', value: typeof value === 'string' ? value : JSON.stringify(value) },
    ],
  };
}

describe('InstructionApprovalActionHandler (#767)', () => {
  it('answers as the clicker from Slack, and says nothing more on success (the DM is rewritten)', async () => {
    const answer = vi.fn().mockReturnValue({ ok: true, decision: 'approve_session', done: Promise.resolve() });
    const handler = new InstructionApprovalActionHandler({ getApprovals: () => ({ answer }) as any });
    const respond = vi.fn();
    await handler.handleAction(click({ requestId: 'iap_1', decision: 'approve_session' }), respond);
    expect(answer).toHaveBeenCalledWith({
      requestId: 'iap_1',
      decision: 'approve_session',
      actor: 'U_OWNER',
      surface: 'slack',
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    ['not_owner', '소유자'],
    ['already_answered', '이미'],
    ['expired', '끝난'],
    ['session_gone', '세션'],
    ['not_found', '찾을 수 없'],
    ['unavailable', '잠시 후'],
  ])('a refusal (%s) is told to the clicker only', async (reason, words) => {
    const answer = vi.fn().mockReturnValue({ ok: false, reason });
    const handler = new InstructionApprovalActionHandler({ getApprovals: () => ({ answer }) as any });
    const respond = vi.fn();
    await handler.handleAction(click({ requestId: 'iap_1', decision: 'deny' }, 'U_OTHER'), respond);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
        replace_original: false,
        text: expect.stringContaining(words),
      }),
    );
  });

  it('a payload that is not ours, or no store, decides nothing', async () => {
    const answer = vi.fn();
    const handler = new InstructionApprovalActionHandler({ getApprovals: () => ({ answer }) as any });
    const respond = vi.fn();
    await handler.handleAction(click('not json'), respond);
    await handler.handleAction(click({ requestId: 'iap_1', decision: 'maybe' }), respond);
    await handler.handleAction({ user: { id: 'U' }, actions: [] }, respond);
    expect(answer).not.toHaveBeenCalled();
    const none = new InstructionApprovalActionHandler({ getApprovals: () => undefined });
    await none.handleAction(click({ requestId: 'iap_1', decision: 'approve' }), respond);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });
});
