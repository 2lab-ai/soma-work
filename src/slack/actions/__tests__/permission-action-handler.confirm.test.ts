/**
 * SSOT 2026-11-02 T4 — Slack asks twice when the AI advised against a call.
 *
 * The first Approve on a red card is refused by the answer path
 * (`confirm_required`); the clicker then gets a second, red question with one
 * button, `approve_tool_confirmed`. That button sends `approve_confirmed`, the
 * only answer that runs it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../permission-prompt-response', () => ({
  answerPermissionPrompt: vi.fn(),
}));

import { ActionHandlers, setActionHandlersProviders } from '@soma/slack/actions';
import { answerPermissionPrompt } from '../../../permission-prompt-response';
import { PermissionActionHandler } from '../permission-action-handler';
import type { RespondFn } from '../types';

const DENY = { recommendation: 'deny' as const, summary: '홈 폴더를 지웁니다', risk: '되돌릴 수 없습니다' };

function body(actionId: string, value = 'approval_42', user = 'U_REQ') {
  return { user: { id: user }, actions: [{ action_id: actionId, value }] };
}

afterEach(() => vi.clearAllMocks());

describe('PermissionActionHandler — second confirmation', () => {
  it.each([
    ['handleApprove', 'approve'],
    ['handleApproveDisableRule', 'approve_disable_rule'],
  ] as const)('%s on a red prompt asks again, in red, with one confirm button', async (method, decision) => {
    vi.mocked(answerPermissionPrompt).mockResolvedValue({ ok: false, reason: 'confirm_required', advice: DENY });
    const respond = vi.fn().mockResolvedValue(undefined);
    await new PermissionActionHandler()[method](body('x'), respond as unknown as RespondFn);

    expect(answerPermissionPrompt).toHaveBeenCalledWith(expect.objectContaining({ decision }));
    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0];
    expect(msg.response_type).toBe('ephemeral');
    expect(msg.replace_original).toBe(false);
    const all = JSON.stringify(msg);
    expect(all).toContain('🔴');
    expect(all).toContain('되돌릴 수 없습니다');
    expect(all).toContain('정말 실행');
    const confirm = msg.blocks
      .find((b: any) => b.type === 'actions')
      .elements.find((e: any) => e.action_id === 'approve_tool_confirmed');
    expect(confirm).toMatchObject({ style: 'danger', value: 'approval_42' });
  });

  it('the confirm button sends approve_confirmed and replaces the question', async () => {
    vi.mocked(answerPermissionPrompt).mockResolvedValue({ ok: true, pending: {} as never, disabledRuleIds: [] });
    const respond = vi.fn().mockResolvedValue(undefined);
    await new PermissionActionHandler().handleApproveConfirmed(
      body('approve_tool_confirmed'),
      respond as unknown as RespondFn,
    );
    expect(answerPermissionPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'approval_42', actor: 'U_REQ', decision: 'approve_confirmed' }),
    );
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ replace_original: true }));
  });

  it('a confirm that is no longer answerable says why', async () => {
    vi.mocked(answerPermissionPrompt).mockResolvedValue({ ok: false, reason: 'already_answered' });
    const respond = vi.fn().mockResolvedValue(undefined);
    await new PermissionActionHandler().handleApproveConfirmed(
      body('approve_tool_confirmed'),
      respond as unknown as RespondFn,
    );
    expect(JSON.stringify(respond.mock.calls[0][0])).toContain('already answered');
  });
});

describe('ActionHandlers — the confirm button is wired', () => {
  it('registers approve_tool_confirmed to handleApproveConfirmed', async () => {
    const permissionHandler = {
      handleApprove: vi.fn(),
      handleDeny: vi.fn(),
      handleExplain: vi.fn(),
      handleApproveDisableRule: vi.fn(),
      handleApproveConfirmed: vi.fn().mockResolvedValue(undefined),
    };
    // The package's routing with only the permission delegate supplied (the composition root supplies all).
    setActionHandlersProviders({
      createDelegates: () =>
        ({
          permissionHandler,
          zSettingsHandler: { register: vi.fn() },
          registerCctActions: vi.fn(),
        }) as never,
    });
    const handlers = new ActionHandlers({} as never);
    const registered = new Map<unknown, (args: any) => Promise<void>>();
    handlers.registerHandlers({
      action: (id: unknown, fn: (args: any) => Promise<void>) => registered.set(id, fn),
      view: vi.fn(),
    } as never);
    const fn = registered.get('approve_tool_confirmed');
    expect(fn).toBeTypeOf('function');
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();
    await fn?.({ ack, body: body('approve_tool_confirmed'), respond });
    expect(ack).toHaveBeenCalled();
    expect(permissionHandler.handleApproveConfirmed).toHaveBeenCalledWith(body('approve_tool_confirmed'), respond);
  });
});
