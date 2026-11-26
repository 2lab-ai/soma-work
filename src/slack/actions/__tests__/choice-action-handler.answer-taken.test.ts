import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAwaitingUserChoice } from '../../../agent-session/derive-status';
import { ChoiceActionHandler } from '../choice-action-handler';

/**
 * #1474 — an answer that arrives before the turn that asked has ended must not get locked behind that question
 * again.
 *
 * Every answer path writes to Slack first (the question card loses its buttons) and only then cleared the
 * question's open bit (`actionPanel.waitingForChoice`). The turn that asked reads that bit when it ends
 * (`stream-executor.ts` choiceStillOpen, `isAwaitingUserChoice` in the dispatch outcome). On a busy host the one
 * Slack line ran an hour behind (#1470): a turn ending while the answer's Slack write waited read the question as
 * still open, ended `waiting`, its run settled `blocked: awaiting user choice`, the follow-up drain stopped, and the
 * card read NEEDS YOU again — with the answer already given.
 *
 * So the bit goes down the moment the answer is taken, before any Slack write. A question the model asks after that
 * raises it again and still holds.
 */

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createFormStore() {
  const forms = new Map<string, any>();
  return {
    get: (id: string) => forms.get(id),
    set: (id: string, data: any) => forms.set(id, data),
    delete: (id: string) => forms.delete(id),
    getFormsBySession: (key: string) => new Map([...forms].filter(([, f]) => f?.sessionKey === key)),
  };
}

const KEY = 'C1:root';
const QUESTION = {
  type: 'user_choice' as const,
  question: '어떻게 할까요?',
  choices: [
    { id: '1', label: '진행' },
    { id: '2', label: '중단' },
  ],
};

describe('ChoiceActionHandler — the answer is recorded before its Slack writes (#1474)', () => {
  let session: any;
  let slackWrite: ReturnType<typeof deferred>;
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let formStore: ReturnType<typeof createFormStore>;
  let handler: ChoiceActionHandler;

  beforeEach(() => {
    session = {
      channelId: 'C1',
      threadTs: 'root',
      threadRootTs: 'root',
      ownerId: 'U1',
      activityState: 'waiting',
      activityStateChangedAt: 1,
      actionPanel: { waitingForChoice: true, choiceMessageTs: 'q-ts', pendingQuestion: QUESTION },
    };
    slackWrite = deferred();
    slackApi = {
      // The one Slack line is an hour behind: the question card's edit does not answer.
      updateMessage: vi.fn(() => slackWrite.promise),
      postEphemeral: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    let clock = 1;
    claudeHandler = {
      getSessionByKey: vi.fn(() => session),
      setActivityStateByKey: vi.fn((_key: string, state: string) => {
        session.activityState = state;
        session.activityStateChangedAt = ++clock;
      }),
      getSessionRegistry: () => ({ persistAndBroadcast: vi.fn() }),
    };
    messageHandler = vi.fn().mockResolvedValue(undefined);
    formStore = createFormStore();
    handler = new ChoiceActionHandler(
      {
        slackApi,
        claudeHandler,
        messageHandler,
        threadPanel: { clearChoice: vi.fn().mockResolvedValue(undefined), attachChoice: vi.fn() },
      } as any,
      formStore as any,
    );
  });

  /** What the turn that asked reads when it ends now (the dispatch outcome's ASK pause). */
  const turnEndingNowWaits = () => isAwaitingUserChoice(true, session.actionPanel?.waitingForChoice);

  it('a Slack button answer: the question is answered while its card edit still waits for Slack', async () => {
    const answering = handler.handleUserChoice({
      actions: [
        { value: JSON.stringify({ sessionKey: KEY, choiceId: '1', label: '진행', question: QUESTION.question }) },
      ],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'q-ts' },
    });
    await Promise.resolve();

    expect(slackApi.updateMessage).toHaveBeenCalled();
    expect(messageHandler).not.toHaveBeenCalled();
    expect(session.actionPanel.waitingForChoice).toBe(false);
    expect(session.activityState).toBe('working');
    expect(turnEndingNowWaits()).toBe(false);

    slackWrite.release();
    await answering;
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '1', questionAnswer: true }),
      expect.any(Function),
    );
  });

  it('a dashboard answer: the same, and the answer is marked as one', async () => {
    const answering = handler.handleChoiceFromDashboard(KEY, '2', '중단', QUESTION.question, 'U1');
    await Promise.resolve();

    expect(slackApi.updateMessage).toHaveBeenCalled();
    expect(session.actionPanel.waitingForChoice).toBe(false);
    expect(turnEndingNowWaits()).toBe(false);

    slackWrite.release();
    await answering;
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '2', questionAnswer: true }),
      expect.any(Function),
    );
  });

  it('a question the model asks after the answer was taken still holds', async () => {
    const answering = handler.handleChoiceFromDashboard(KEY, '1', '진행', QUESTION.question, 'U1');
    await Promise.resolve();
    expect(turnEndingNowWaits()).toBe(false);

    // The running turn asks again (stream-executor onChoiceCreated raises the bit).
    session.actionPanel.waitingForChoice = true;
    expect(turnEndingNowWaits()).toBe(true);

    slackWrite.release();
    await answering;
  });

  it('a dashboard answer given back after its send failed opens the question again, bit and all', async () => {
    slackWrite.release();
    messageHandler.mockRejectedValueOnce(new Error('send failed'));

    await expect(handler.handleChoiceFromDashboard(KEY, '1', '진행', QUESTION.question, 'U1')).rejects.toThrow(
      'send failed',
    );

    expect(session.activityState).toBe('waiting');
    expect(session.actionPanel.pendingQuestion).toBe(QUESTION);
    expect(session.actionPanel.waitingForChoice).toBe(true);
    expect(turnEndingNowWaits()).toBe(true);
  });

  it('a Slack form submit: answered before its "submitting" edit, marked as an answer', async () => {
    formStore.set('form-1', {
      formId: 'form-1',
      sessionKey: KEY,
      channel: 'C1',
      threadTs: 'root',
      messageTs: 'form-ts',
      questions: [{ id: 'q1', question: '전략?', choices: [{ id: '1', label: '빠른 수정' }] }],
      selections: { q1: { choiceId: '1', label: '빠른 수정' } },
      createdAt: Date.now(),
    });

    const submitting = handler.handleFormSubmit({
      actions: [{ value: JSON.stringify({ formId: 'form-1', sessionKey: KEY }) }],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'form-ts' },
    });
    await Promise.resolve();

    expect(slackApi.updateMessage).toHaveBeenCalled();
    expect(session.actionPanel.waitingForChoice).toBe(false);
    expect(turnEndingNowWaits()).toBe(false);

    slackWrite.release();
    await submitting;
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ questionAnswer: true }),
      expect.any(Function),
    );
  });

  it('a click on an older question takes nothing: the open question stays open', async () => {
    slackWrite.release();
    session.actionPanel.pendingChoice = { kind: 'single', turnId: 'turn-new', choiceTs: 'q-ts' };
    await handler.handleUserChoice({
      actions: [
        {
          value: JSON.stringify({
            sessionKey: KEY,
            choiceId: '1',
            label: '진행',
            question: QUESTION.question,
            turnId: 'turn-old',
          }),
        },
      ],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'old-q-ts' },
    });

    expect(session.actionPanel.waitingForChoice).toBe(true);
    expect(session.activityState).toBe('waiting');
    expect(messageHandler).not.toHaveBeenCalled();
  });
});
