import { afterEach, describe, expect, it, vi } from 'vitest';
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
