import { afterEach, describe, expect, it, vi } from 'vitest';
import { setInstructionApprovals } from '../../../instruction-approval';
import { FormActionHandler } from '../form-action-handler';

/**
 * #767 (astra R3) — a typed answer (직접입력 modal) from someone who is not the
 * owner is checked before the question is touched: a single question's answer
 * is handed to the message gate (held, the question stays open), a form's is
 * refused.
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
      choiceMessageTs: 'q-ts',
      pendingChoice: { kind: 'single', turnId: 't1' },
      pendingQuestion: { type: 'user_choice', question: 'Q?', choices: [{ id: '1', label: 'A' }] },
    },
  };
  setInstructionApprovals({ allows: vi.fn().mockReturnValue(allowed) } as any);
  const slackApi = {
    postEphemeral: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue({ ts: 'p' }),
  };
  const threadPanel = { resolveChoice: vi.fn().mockResolvedValue(true), clearChoice: vi.fn() };
  const claudeHandler = {
    getSessionByKey: vi.fn().mockReturnValue(session),
    setActivityStateByKey: vi.fn(),
    getSessionRegistry: () => ({ persistAndBroadcast: vi.fn() }),
  };
  const messageHandler = vi.fn().mockResolvedValue(undefined);
  const handler = new FormActionHandler(
    { slackApi, claudeHandler, messageHandler, threadPanel } as any,
    { get: () => undefined, set() {}, delete() {} } as any,
    {} as any,
  );
  return { handler, slackApi, threadPanel, claudeHandler, messageHandler, session };
}

function submit(type: 'single' | 'multi', user = 'U_OTHER') {
  return {
    body: { user: { id: user } },
    view: {
      private_metadata: JSON.stringify({
        sessionKey: SESSION_KEY,
        question: 'Q?',
        channel: 'C123',
        messageTs: 'q-ts',
        threadTs: 'thread-root',
        type,
        formId: 'f1',
        questionId: 'q1',
        turnId: 't1',
      }),
      state: { values: { custom_input_block: { custom_input_text: { value: '내가 쓴 답' } } } },
    },
  };
}

describe('FormActionHandler — someone else’s typed answer waits for the owner (#767)', () => {
  afterEach(() => setInstructionApprovals(undefined));

  it('a single question’s typed answer goes to the gate; the question is not consumed', async () => {
    const { handler, threadPanel, claudeHandler, messageHandler, slackApi, session } = setup(false);
    const { body, view } = submit('single');
    await handler.handleCustomInputSubmit(body, view);
    expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
    expect(claudeHandler.setActivityStateByKey).not.toHaveBeenCalled();
    expect(session.actionPanel.pendingQuestion).toBeDefined();
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U_OTHER', channel: 'C123', text: '내가 쓴 답' }),
      expect.any(Function),
    );
    expect(slackApi.postEphemeral).toHaveBeenCalledWith('C123', 'U_OTHER', expect.stringContaining('승인'));
  });

  it('a form’s typed answer from someone else is refused', async () => {
    const { handler, messageHandler, slackApi } = setup(false);
    const { body, view } = submit('multi');
    await handler.handleCustomInputSubmit(body, view);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(slackApi.postEphemeral).toHaveBeenCalledWith('C123', 'U_OTHER', expect.stringContaining('소유자'));
  });

  it('the owner’s typed answer is handled as before', async () => {
    const { handler, slackApi } = setup(true);
    const { body, view } = submit('single', 'U_OWNER');
    await handler.handleCustomInputSubmit(body, view);
    expect(slackApi.postEphemeral).not.toHaveBeenCalledWith(
      'C123',
      'U_OWNER',
      expect.stringContaining('소유자가 승인하면'),
    );
  });
});
