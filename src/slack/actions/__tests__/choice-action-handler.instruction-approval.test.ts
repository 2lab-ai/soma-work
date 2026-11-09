import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn((userId: string) => userId === 'U_ADMIN'),
}));

import { setInstructionApprovals } from '../../../instruction-approval';
import { ChoiceActionHandler, FORM_OWNER_ONLY_ERROR } from '../choice-action-handler';

/**
 * #767 (trinity R1) — an answer to the owner's question from someone else is an
 * instruction too: it is handed to the message gate (which holds it for the
 * owner) BEFORE the question is consumed, so the question stays open; a
 * multi-question form is the owner's (or an approved person's) to answer.
 */

const SESSION_KEY = 'C123:thread-root';

function setup(allowed: boolean) {
  const session = {
    ownerId: 'U_OWNER',
    channelId: 'C123',
    threadRootTs: 'thread-root',
    threadTs: 'thread-root',
    activityState: 'waiting',
    actionPanel: {
      waitingForChoice: true,
      choiceMessageTs: 'choice-ts',
      pendingChoice: { kind: 'single', turnId: 't1' },
      pendingQuestion: { type: 'user_choice', question: 'Q?', choices: [{ id: '1', label: 'A' }] },
    },
  };
  const allows = vi.fn().mockReturnValue(allowed);
  setInstructionApprovals({ allows } as any);
  const slackApi = {
    updateMessage: vi.fn().mockResolvedValue(undefined),
    postEphemeral: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
  };
  const messageHandler = vi.fn().mockResolvedValue(undefined);
  const threadPanel = {
    resolveChoice: vi.fn().mockResolvedValue(true),
    clearChoice: vi.fn().mockResolvedValue(undefined),
    attachChoice: vi.fn().mockResolvedValue(undefined),
  };
  const claudeHandler = {
    getSessionByKey: vi.fn().mockReturnValue(session),
    setActivityStateByKey: vi.fn(),
  };
  const handler = new ChoiceActionHandler(
    { slackApi, claudeHandler, messageHandler, threadPanel } as any,
    { get: () => undefined, set() {}, delete() {}, getFormsBySession: () => new Map() } as any,
  );
  return { handler, slackApi, messageHandler, threadPanel, allows, session };
}

function click(user: string) {
  return {
    user: { id: user },
    channel: { id: 'C123' },
    message: { ts: 'choice-ts', thread_ts: 'thread-root' },
    actions: [
      { value: JSON.stringify({ sessionKey: SESSION_KEY, choiceId: '1', label: 'A', question: 'Q?', turnId: 't1' }) },
    ],
  };
}

describe('ChoiceActionHandler — someone else’s answer waits for the owner (#767)', () => {
  afterEach(() => setInstructionApprovals(undefined));

  it('a Slack choice from someone else is handed to the gate; the question is not consumed', async () => {
    const { handler, messageHandler, threadPanel, slackApi, allows } = setup(false);
    await handler.handleUserChoice(click('U_OTHER'));
    expect(allows).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: SESSION_KEY, senderId: 'U_OTHER' }));
    expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U_OTHER', channel: 'C123', thread_ts: 'thread-root', text: '1' }),
      expect.any(Function),
    );
    expect(slackApi.postEphemeral).toHaveBeenCalledWith('C123', 'U_OTHER', expect.stringContaining('승인'));
  });

  it('two answers to the same question are two held items — each has its own ts, not the question’s (trinity R2)', async () => {
    const { handler, messageHandler } = setup(false);
    await handler.handleUserChoice(click('U_OTHER'));
    await new Promise((r) => setTimeout(r, 2));
    await handler.handleUserChoice(click('U_OTHER'));
    const tss = messageHandler.mock.calls.map((c: any[]) => c[0].ts);
    expect(tss).toHaveLength(2);
    expect(new Set(tss).size).toBe(2);
    expect(tss).not.toContain('choice-ts');
  });

  it('a dashboard choice from someone else is held the same way', async () => {
    const { handler, messageHandler, threadPanel } = setup(false);
    await handler.handleChoiceFromDashboard(SESSION_KEY, '1', 'A', 'Q?', 'U_OTHER');
    expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U_OTHER', text: '1' }),
      expect.any(Function),
    );
  });

  it('a multi-question form from someone else is refused on the dashboard (403 words)', async () => {
    const { handler } = setup(false);
    await expect(handler.handleMultiChoiceFromDashboard(SESSION_KEY, {}, 'U_OTHER')).rejects.toThrow(
      FORM_OWNER_ONLY_ERROR,
    );
    await expect(handler.handleSubmitRecommendedFromDashboard(SESSION_KEY, 'U_OTHER')).rejects.toThrow(
      FORM_OWNER_ONLY_ERROR,
    );
  });

  it('someone else cannot change the owner’s form selections — select, edit, reset (astra R3)', async () => {
    const { handler, slackApi } = setup(false);
    const body = (value: Record<string, unknown>) => ({
      user: { id: 'U_OTHER' },
      channel: { id: 'C123' },
      message: { ts: 'form-ts', thread_ts: 'thread-root' },
      actions: [{ value: JSON.stringify({ sessionKey: SESSION_KEY, formId: 'f1', questionId: 'q1', ...value }) }],
    });
    const forms = new Map<string, any>([
      [
        'f1',
        {
          formId: 'f1',
          sessionKey: SESSION_KEY,
          channel: 'C123',
          threadTs: 'thread-root',
          messageTs: 'form-ts',
          questions: [
            {
              id: 'q1',
              question: 'Q1?',
              choices: [
                { id: '1', label: 'A' },
                { id: '2', label: 'B' },
              ],
            },
          ],
          selections: { q1: { choiceId: '1', label: 'A' } },
          createdAt: Date.now(),
        },
      ],
    ]);
    const formStore = {
      get: (id: string) => forms.get(id),
      set: (id: string, v: any) => forms.set(id, v),
      delete: (id: string) => forms.delete(id),
      getFormsBySession: () => new Map(forms),
    };
    (handler as any).formStore = formStore;
    const before = JSON.stringify(formStore.get('f1') ?? null);
    await handler.handleMultiChoice(body({ choiceId: '2', label: 'B' }));
    await handler.handleEditChoice(body({}));
    await handler.handleFormReset(body({}));
    expect(JSON.stringify(formStore.get('f1') ?? null)).toBe(before);
    expect(slackApi.postEphemeral).toHaveBeenCalledTimes(3);
    for (const call of slackApi.postEphemeral.mock.calls) expect(call[2]).toContain('소유자');
  });

  it('the owner (or an approved person) answers as before', async () => {
    const { handler, slackApi, allows } = setup(true);
    await handler.handleUserChoice(click('U_OWNER'));
    expect(allows).toHaveBeenCalled();
    // Not handed to the gate: no "waits for the owner" line to the clicker.
    expect(slackApi.postEphemeral).not.toHaveBeenCalledWith(
      'C123',
      'U_OWNER',
      expect.stringContaining('소유자가 승인하면'),
    );
  });
});

describe('ChoiceActionHandler — an admin answering a question asked for admins (#1070)', () => {
  afterEach(() => setInstructionApprovals(undefined));

  function adminQuestion(setupResult: ReturnType<typeof setup>) {
    (setupResult.session.actionPanel.pendingQuestion as any).audience = 'admins';
    return setupResult;
  }

  it('is not held for the owner: the question is answered, and the turn runs as the owner, naming the admin', async () => {
    const { handler, messageHandler, threadPanel, allows } = adminQuestion(setup(false));
    const onClaimed = vi.fn();
    await handler.handleChoiceFromDashboard(SESSION_KEY, '1', 'A', 'Q?', 'U_ADMIN', { adminAnswer: true, onClaimed });
    expect(allows).not.toHaveBeenCalled();
    expect(onClaimed).toHaveBeenCalledTimes(1);
    expect(threadPanel.resolveChoice.mock.calls[0][3]).toContain('대시보드 · <@U_ADMIN>');
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U_OWNER', text: '1' }),
      expect.any(Function),
    );
  });

  it('the legacy (non-P3) path also runs the turn as the owner and names the admin', async () => {
    const result = adminQuestion(setup(false));
    (result.session.actionPanel as any).pendingChoice = undefined;
    await result.handler.handleChoiceFromDashboard(SESSION_KEY, '1', 'A', 'Q?', 'U_ADMIN', { adminAnswer: true });
    expect(result.threadPanel.resolveChoice).not.toHaveBeenCalled();
    expect(result.slackApi.updateMessage.mock.calls[0][2]).toContain('대시보드 · <@U_ADMIN>');
    expect(result.messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U_OWNER', text: '1' }),
      expect.any(Function),
    );
  });

  it('refuses the flag from a non-admin or for the owner’s own question, before anything is consumed', async () => {
    const asNonAdmin = adminQuestion(setup(false));
    await expect(
      asNonAdmin.handler.handleChoiceFromDashboard(SESSION_KEY, '1', 'A', 'Q?', 'U_OTHER', { adminAnswer: true }),
    ).rejects.toThrow('Not an admin question');
    const ownersQuestion = setup(false);
    await expect(
      ownersQuestion.handler.handleChoiceFromDashboard(SESSION_KEY, '1', 'A', 'Q?', 'U_ADMIN', { adminAnswer: true }),
    ).rejects.toThrow('Not an admin question');
    for (const { threadPanel, messageHandler } of [asNonAdmin, ownersQuestion]) {
      expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
      expect(messageHandler).not.toHaveBeenCalled();
    }
  });

  it('without the flag an admin who is not the owner is still held, as before', async () => {
    const { handler, threadPanel, messageHandler } = adminQuestion(setup(false));
    await handler.handleChoiceFromDashboard(SESSION_KEY, '1', 'A', 'Q?', 'U_ADMIN');
    expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
    expect(messageHandler).toHaveBeenCalledWith(
      expect.not.objectContaining({ routeContext: expect.anything() }),
      expect.any(Function),
    );
  });
});
