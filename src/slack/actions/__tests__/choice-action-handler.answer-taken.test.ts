import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAwaitingUserChoice } from '../../../agent-session/derive-status';
import { AnswerNotKeptError } from '../answer-not-kept';
import { ChoiceActionHandler } from '../choice-action-handler';

/**
 * #1474 — an answer that arrives before the turn that asked has ended must not get locked behind that question
 * again, and must not be overtaken while it waits for Slack.
 *
 * Every answer path used to write to Slack first (the question card loses its buttons) and only then clear the
 * question and hand the answer on. On a busy host Slack's one serial lane ran an hour behind (#1470): a turn ending
 * meanwhile read the question as still open (`waitingForChoice`), ended `waiting`, its run settled `blocked:
 * awaiting user choice` and the line stopped — with the answer already given; and the answer sat in no queue while
 * other messages could move on.
 *
 * Now an answer is recorded (the question leaves the session), handed on (into the queue or as the next turn) and
 * only then drawn, the drawing alongside. A question the model asks after that still holds; a hand-on that fails
 * gives the question back.
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

describe('ChoiceActionHandler — recorded, handed on, then drawn (#1474)', () => {
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
        threadPanel: { clearChoice: vi.fn(), attachChoice: vi.fn(), updatePanel: vi.fn().mockResolvedValue(undefined) },
      } as any,
      formStore as any,
    );
  });

  /** What the turn that asked reads when it ends now (the dispatch outcome's ASK pause). */
  const turnEndingNowWaits = () => isAwaitingUserChoice(true, session.actionPanel?.waitingForChoice);
  const button = (choiceId: string) => ({
    actions: [{ value: JSON.stringify({ sessionKey: KEY, choiceId, label: '진행', question: QUESTION.question }) }],
    user: { id: 'U1' },
    channel: { id: 'C1' },
    message: { ts: 'q-ts' },
  });

  it('a Slack button answer is in the pipeline, and the question gone, while its card edit still waits', async () => {
    const answering = handler.handleUserChoice(button('1'));
    await Promise.resolve();

    expect(slackApi.updateMessage).toHaveBeenCalled(); // the edit is in Slack's line, not answered
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '1', questionAnswer: true }),
      expect.any(Function),
    );
    expect(session.actionPanel.waitingForChoice).toBe(false);
    expect(session.actionPanel.pendingQuestion).toBeUndefined();
    expect(session.activityState).toBe('working');
    expect(turnEndingNowWaits()).toBe(false);

    slackWrite.release();
    await answering;
  });

  it('a dashboard answer: the same', async () => {
    const answering = handler.handleChoiceFromDashboard(KEY, '2', '중단', QUESTION.question, 'U1');
    await Promise.resolve();

    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '2', questionAnswer: true }),
      expect.any(Function),
    );
    expect(session.actionPanel.waitingForChoice).toBe(false);
    expect(turnEndingNowWaits()).toBe(false);

    slackWrite.release();
    await answering;
  });

  it('a question the model asks while the answer is still being drawn stays open after the drawing', async () => {
    const next = { type: 'user_choice', question: '다음은?', choices: [{ id: '1', label: 'A' }] };
    const answering = handler.handleChoiceFromDashboard(KEY, '1', '진행', QUESTION.question, 'U1');
    await Promise.resolve();
    // The running turn asks again (stream-executor: the question recorded, the open bit up).
    session.actionPanel.pendingQuestion = next;
    session.actionPanel.waitingForChoice = true;

    slackWrite.release();
    await answering;

    expect(session.actionPanel.pendingQuestion).toBe(next);
    expect(session.actionPanel.waitingForChoice).toBe(true);
    expect(turnEndingNowWaits()).toBe(true);
  });

  it('an answer the queue did not keep gives the question back, though the turn that asked has ended', async () => {
    slackWrite.release();
    messageHandler.mockImplementationOnce(async () => {
      claudeHandler.setActivityStateByKey(KEY, 'idle'); // the turn that asked ended meanwhile
      throw new AnswerNotKeptError('capacity');
    });

    await expect(handler.handleChoiceFromDashboard(KEY, '1', '진행', QUESTION.question, 'U1')).rejects.toThrow(
      AnswerNotKeptError,
    );

    expect(session.activityState).toBe('waiting');
    expect(session.actionPanel.pendingQuestion).toBe(QUESTION);
    expect(session.actionPanel.waitingForChoice).toBe(true);
    expect(session.actionPanel.choiceMessageTs).toBe('q-ts');
    expect(turnEndingNowWaits()).toBe(true);
  });

  it('a dispatch that failed before any turn started gives the question back', async () => {
    slackWrite.release();
    messageHandler.mockRejectedValueOnce(new Error('session init failed'));

    await handler.handleUserChoice(button('1'));

    expect(session.activityState).toBe('waiting');
    expect(session.actionPanel.pendingQuestion).toBe(QUESTION);
    expect(session.actionPanel.waitingForChoice).toBe(true);
  });

  it('a failure after the answer’s own turn ran does not offer the used answer again', async () => {
    slackWrite.release();
    messageHandler.mockImplementationOnce(async () => {
      claudeHandler.setActivityStateByKey(KEY, 'working'); // the answer's turn ran…
      claudeHandler.setActivityStateByKey(KEY, 'idle'); // …and ended; then something after it failed
      throw new Error('drain failed');
    });

    await expect(handler.handleChoiceFromDashboard(KEY, '1', '진행', QUESTION.question, 'U1')).rejects.toThrow(
      'drain failed',
    );

    expect(session.actionPanel.pendingQuestion).toBeUndefined();
    expect(session.activityState).toBe('idle');
  });

  it('a Slack form submit is handed on before its message is drawn, and closes the question', async () => {
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

    expect(messageHandler).toHaveBeenCalledWith(expect.objectContaining({ questionAnswer: true }), expect.any(Function));
    expect(session.actionPanel.waitingForChoice).toBe(false);
    expect(turnEndingNowWaits()).toBe(false);

    slackWrite.release();
    await submitting;
  });

  it('a chunk of a form other chunks still answer keeps the question open; the last chunk closes it', async () => {
    const record = { kind: 'multi', turnId: 'turn-1', formIds: ['form-a', 'form-b'] };
    session.actionPanel.pendingChoice = record;
    const form = (formId: string, messageTs: string) => ({
      formId,
      sessionKey: KEY,
      channel: 'C1',
      threadTs: 'root',
      messageTs,
      turnId: 'turn-1',
      questions: [{ id: formId, question: `${formId}?`, choices: [{ id: '1', label: 'A' }] }],
      selections: { [formId]: { choiceId: '1', label: 'A' } },
      createdAt: Date.now(),
    });
    formStore.set('form-a', form('form-a', 'ts-a'));
    formStore.set('form-b', form('form-b', 'ts-b'));
    slackWrite.release();
    const submit = (formId: string, ts: string) =>
      handler.handleFormSubmit({
        actions: [{ value: JSON.stringify({ formId, sessionKey: KEY }) }],
        user: { id: 'U1' },
        channel: { id: 'C1' },
        message: { ts },
      });

    await submit('form-a', 'ts-a');
    expect(session.actionPanel.waitingForChoice).toBe(true);
    expect(session.actionPanel.pendingQuestion).toBe(QUESTION);
    expect(session.actionPanel.pendingChoice).toMatchObject({ formIds: ['form-b'] });
    expect(turnEndingNowWaits()).toBe(true);

    await submit('form-b', 'ts-b');
    expect(session.actionPanel.waitingForChoice).toBe(false);
    expect(session.actionPanel.pendingQuestion).toBeUndefined();
    expect(session.actionPanel.pendingChoice).toBeUndefined();
    expect(messageHandler).toHaveBeenCalledTimes(2);
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
