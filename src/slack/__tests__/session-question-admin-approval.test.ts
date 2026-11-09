import { afterEach, describe, expect, it, vi } from 'vitest';

// #1070 — a question the model asked for an admin (`audience: 'admins'`) is also a card on the dashboard's
// 관리자 승인 screen, answered through the same choice path as the session view, as the admin.

vi.mock('../../admin-utils', () => ({
  isAdminUser: vi.fn((userId: string) => userId === 'U_ADMIN'),
}));

import { setInstructionApprovals } from '../../instruction-approval';
import { ChoiceActionHandler } from '../actions/choice-action-handler';
import { sessionQuestionAdminApprovalAdapter } from '../session-question-admin-approval';

const QUESTION = {
  type: 'user_choice',
  audience: 'admins',
  question: '시험 카드를 승인할까요?',
  context: 'devops 카드 2장이 대기 중입니다',
  choices: [
    { id: 'approve', label: '승인한다', description: '카드에서 승인' },
    { id: 'stop', label: '그만둔다' },
    { id: 'later', label: '나중에' },
  ],
  recommendedChoiceId: 'approve',
};

function session(over: Record<string, unknown> = {}, question: Record<string, unknown> = QUESTION) {
  return {
    ownerId: 'U_OWNER',
    channelId: 'C123',
    threadRootTs: 'root-ts',
    threadTs: 'root-ts',
    activityState: 'waiting',
    actionPanel: {
      choiceMessageTs: 'choice-ts',
      pendingChoice: { kind: 'single', turnId: 't1', choiceTs: 'choice-ts', formIds: [], createdAt: 1_700_000_000_000 },
      pendingQuestion: question,
    },
    ...over,
  } as any;
}

function adapterWith(sessions: [string, any][], answer = vi.fn().mockResolvedValue(undefined)) {
  const adapter = sessionQuestionAdminApprovalAdapter({ sessions: () => sessions, answer, now: () => 42 });
  return { adapter, answer };
}

describe('sessionQuestionAdminApprovalAdapter', () => {
  it('lists a waiting question asked for admins as a card with its question, context, choices and place', () => {
    const { adapter } = adapterWith([['C123:root-ts', session()]]);
    expect(adapter.pending(0)).toEqual([
      {
        id: 'session_question:C123:root-ts~choice-ts',
        kind: 'session_question',
        card: 'question',
        title: '시험 카드를 승인할까요?',
        description: 'devops 카드 2장이 대기 중입니다',
        choices: [
          { id: 'approve', label: '승인한다', description: '카드에서 승인' },
          { id: 'stop', label: '그만둔다' },
          { id: 'later', label: '나중에' },
        ],
        recommendedId: 'approve',
        requesterId: 'U_OWNER',
        place: { channel: 'C123', threadTs: 'root-ts' },
        createdAt: 1_700_000_000_000,
      },
    ]);
  });

  it('lists nothing for the owner’s own questions, a form, or a session that is not waiting', () => {
    const { audience: _drop, ...ownerQuestion } = QUESTION;
    const { adapter } = adapterWith([
      ['a', session({}, ownerQuestion)],
      ['b', session({}, { type: 'user_choices', audience: 'admins', questions: [] })],
      ['c', session({ activityState: 'working' })],
    ]);
    expect(adapter.pending(0)).toEqual([]);
  });

  it('answers as the admin through the choice path, marked as an admin answer, and records who answered', async () => {
    const { adapter, answer } = adapterWith([['C123:root-ts', session()]]);
    await expect(adapter.answer('C123:root-ts~choice-ts', 'approve', 'U_ADMIN')).resolves.toEqual({
      ok: true,
      outcome: 'approved',
    });
    expect(answer).toHaveBeenCalledWith('C123:root-ts', 'approve', '승인한다', '시험 카드를 승인할까요?', 'U_ADMIN', {
      adminAnswer: true,
      onClaimed: expect.any(Function),
    });
    expect(await adapter.resolved(0)).toEqual([
      {
        id: 'session_question:C123:root-ts~choice-ts',
        outcome: 'approved',
        choiceId: 'approve',
        by: 'U_ADMIN',
        via: 'dashboard',
        at: 42,
      },
    ]);
  });

  it('refuses a non-admin, an unknown choice, a gone session and a question answered or replaced meanwhile', async () => {
    const { adapter, answer } = adapterWith([['C123:root-ts', session()]]);
    expect(await adapter.answer('C123:root-ts~choice-ts', 'approve', 'U_OWNER')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await adapter.answer('C123:root-ts~choice-ts', 'nope', 'U_ADMIN')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await adapter.answer('C999:gone~choice-ts', 'approve', 'U_ADMIN')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    // A newer question in the same session has another stamp.
    expect(await adapter.answer('C123:root-ts~older-ts', 'approve', 'U_ADMIN')).toMatchObject({
      ok: false,
      reason: 'already_answered',
    });
    expect(answer).not.toHaveBeenCalled();
  });

  it('maps the choice path’s refusals; anything else is thrown', async () => {
    const refusing = (message: string) => vi.fn().mockRejectedValue(new Error(message));
    for (const [message, reason] of [
      ['Session not found', 'not_found'],
      ['Session is not waiting for a choice', 'already_answered'],
      ['Invalid choice ID', 'invalid'],
      ['Not an admin question', 'invalid'],
    ] as const) {
      const { adapter } = adapterWith([['C123:root-ts', session()]], refusing(message));
      expect(await adapter.answer('C123:root-ts~choice-ts', 'approve', 'U_ADMIN')).toEqual({ ok: false, reason });
    }
    const { adapter } = adapterWith([['C123:root-ts', session()]], refusing('slack down'));
    await expect(adapter.answer('C123:root-ts~choice-ts', 'approve', 'U_ADMIN')).rejects.toThrow('slack down');
  });
});

describe('sessionQuestionAdminApprovalAdapter wired to the real ChoiceActionHandler (#1070 review)', () => {
  afterEach(() => setInstructionApprovals(undefined));

  function wired(turn: () => Promise<void>) {
    const s = session();
    // The owner has not approved anyone: an answer from someone else would be held.
    setInstructionApprovals({ allows: vi.fn().mockReturnValue(false) } as any);
    const messageHandler = vi.fn((_event: any, _say: any) => turn());
    const threadPanel = {
      resolveChoice: vi.fn().mockResolvedValue(true),
      clearChoice: vi.fn().mockResolvedValue(undefined),
      attachChoice: vi.fn().mockResolvedValue(undefined),
    };
    const handler = new ChoiceActionHandler(
      {
        slackApi: { updateMessage: vi.fn().mockResolvedValue(undefined), postEphemeral: vi.fn() },
        claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(s), setActivityStateByKey: vi.fn() },
        messageHandler,
        threadPanel,
      } as any,
      { get: () => undefined, set() {}, delete() {}, getFormsBySession: () => new Map() } as any,
    );
    const adapter = sessionQuestionAdminApprovalAdapter({
      sessions: () => [['C123:root-ts', s]],
      answer: (...args) => handler.handleChoiceFromDashboard(...args),
    });
    return { adapter, messageHandler, threadPanel };
  }

  it('answers as soon as the question is taken, while the turn runs — as the owner, naming the admin', async () => {
    const { adapter, messageHandler, threadPanel } = wired(() => new Promise<void>(() => {}));
    await expect(adapter.answer('C123:root-ts~choice-ts', 'approve', 'U_ADMIN')).resolves.toEqual({
      ok: true,
      outcome: 'approved',
    });
    await vi.waitFor(() => expect(messageHandler).toHaveBeenCalled());
    // The owner's session carries on with the owner's own identity and permissions, not the admin's.
    expect(messageHandler.mock.calls[0][0]).toMatchObject({ user: 'U_OWNER', text: 'approve' });
    expect(messageHandler.mock.calls[0][0]).not.toHaveProperty('routeContext');
    expect(threadPanel.resolveChoice.mock.calls[0][3]).toContain('<@U_ADMIN>');
  });

  it('a second answer to the same question is refused as already answered (the real handler’s refusal)', async () => {
    const { adapter, messageHandler } = wired(() => new Promise<void>(() => {}));
    const [first, second] = await Promise.all([
      adapter.answer('C123:root-ts~choice-ts', 'approve', 'U_ADMIN'),
      adapter.answer('C123:root-ts~choice-ts', 'stop', 'U_ADMIN'),
    ]);
    expect(first).toEqual({ ok: true, outcome: 'approved' });
    expect(second).toMatchObject({ ok: false, reason: 'already_answered' });
    await vi.waitFor(() => expect(messageHandler).toHaveBeenCalledTimes(1));
  });

  it('a turn that fails after the answer was taken does not turn the answer into an error', async () => {
    const { adapter } = wired(() => Promise.reject(new Error('turn crashed')));
    await expect(adapter.answer('C123:root-ts~choice-ts', 'approve', 'U_ADMIN')).resolves.toEqual({
      ok: true,
      outcome: 'approved',
    });
  });
});
