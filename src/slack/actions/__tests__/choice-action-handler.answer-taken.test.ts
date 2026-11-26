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

    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ questionAnswer: true }),
      expect.any(Function),
    );
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

  it('a second click on a P3 card while its edit waits sends nothing and does not mark the answered card stale', async () => {
    session.actionPanel.pendingChoice = { kind: 'single', turnId: 'turn-1', choiceTs: 'q-ts', formIds: [] };
    const p3 = (choiceId: string) => ({
      actions: [
        {
          value: JSON.stringify({
            sessionKey: KEY,
            choiceId,
            label: '진행',
            question: QUESTION.question,
            turnId: 'turn-1',
          }),
        },
      ],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'q-ts' },
    });

    const first = handler.handleUserChoice(p3('1'));
    await Promise.resolve();
    // The owner sees no change on the card (Slack's line is behind) and presses again — another option, even.
    await handler.handleUserChoice(p3('2'));

    expect(messageHandler).toHaveBeenCalledTimes(1);
    const staleMarks = slackApi.updateMessage.mock.calls.filter((call: any[]) => String(call[2]).includes('유효하지'));
    expect(staleMarks).toHaveLength(0);
    expect(slackApi.postEphemeral).toHaveBeenCalledWith('C1', 'U1', expect.stringContaining('이미 답변을 받았습니다'));

    slackWrite.release();
    await first;
  });

  it('a second click on a legacy card (no turn on its buttons) is not a second answer', async () => {
    const first = handler.handleUserChoice(button('1'));
    await Promise.resolve();
    await handler.handleUserChoice(button('2'));

    expect(messageHandler).toHaveBeenCalledTimes(1);
    expect(messageHandler).toHaveBeenCalledWith(expect.objectContaining({ text: '1' }), expect.any(Function));
    expect(slackApi.postEphemeral).toHaveBeenCalledWith('C1', 'U1', expect.stringContaining('이미 답변을 받았습니다'));

    slackWrite.release();
    await first;
  });

  it('a given-back answer draws the card open again behind the answered drawing, and the card answers again', async () => {
    messageHandler.mockRejectedValueOnce(new AnswerNotKeptError('capacity'));

    await handler.handleUserChoice(button('1'));
    // The question is back before Slack's line drew anything.
    expect(session.actionPanel.pendingQuestion).toBe(QUESTION);
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1); // the answered drawing, still waiting

    slackWrite.release();
    await vi.waitFor(() => expect(slackApi.updateMessage).toHaveBeenCalledTimes(2));
    const [, ts, text, ...payload] = slackApi.updateMessage.mock.calls[1];
    expect(ts).toBe('q-ts');
    expect(text).toBe(QUESTION.question);
    expect(JSON.stringify(payload)).toContain('"type":"button"');

    // Not remembered as answered any more: the owner answers it again.
    await handler.handleUserChoice(button('2'));
    expect(messageHandler).toHaveBeenCalledTimes(2);
    expect(messageHandler).toHaveBeenLastCalledWith(expect.objectContaining({ text: '2' }), expect.any(Function));
  });

  // #1474 round 12 (astra): a typed reply answered the question (it waits in the person's line, or in the thread's
  // follow-up queue): a legacy form of that question — no turn id to call it stale — is no second answer.
  it('after a typed answer takes the question’s forms, a submit on a legacy form is refused as answered', async () => {
    formStore.set('form-1', {
      formId: 'form-1',
      sessionKey: KEY,
      channel: 'C1',
      threadTs: 'root',
      messageTs: 'form-ts',
      questions: [{ id: 'q1', question: '어느 쪽?', choices: [{ id: 'R', label: '오른쪽' }] }],
      selections: { q1: { choiceId: 'R', label: '오른쪽' } },
      createdAt: Date.now(),
    });
    session.actionPanel = { waitingForChoice: false }; // the typed answer closed the question

    expect(handler.takeAnsweredForms(KEY)).toBe(1);
    expect(formStore.get('form-1')).toBeUndefined();

    await handler.handleFormSubmit({
      actions: [{ value: JSON.stringify({ formId: 'form-1', sessionKey: KEY }) }],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'form-ts' },
    });

    expect(messageHandler).not.toHaveBeenCalled();
    expect(slackApi.postEphemeral).toHaveBeenCalledWith('C1', 'U1', expect.stringContaining('이미 답변을 받았습니다'));
  });

  // #1474 round 13 (fable): a newer question's form is stored before it is posted — a typed reply to the question
  // before it does not take it.
  it('a typed answer leaves a form not yet posted (a newer question’s) in the store, not answered', () => {
    formStore.set('form-old', {
      formId: 'form-old',
      sessionKey: KEY,
      channel: 'C1',
      threadTs: 'root',
      messageTs: 'old-ts',
      questions: [{ id: 'q1', question: '어느 쪽?', choices: [{ id: 'R', label: '오른쪽' }] }],
      selections: {},
      createdAt: Date.now(),
    });
    formStore.set('form-new', {
      formId: 'form-new',
      sessionKey: KEY,
      channel: 'C1',
      threadTs: 'root',
      messageTs: '',
      questions: [{ id: 'q2', question: '다음은?', choices: [{ id: 'A', label: 'A' }] }],
      selections: {},
      createdAt: Date.now(),
    });

    expect(handler.takeAnsweredForms(KEY)).toBe(1);
    expect(formStore.get('form-old')).toBeUndefined();
    expect(formStore.get('form-new')).toBeDefined();
    expect(handler.isAnswered(KEY, 'form-new')).toBe(false);
  });

  // #1474 round 14 (astra): a split form's ts are filled only after its last chunk is up — the open choice's own
  // forms are taken by the answer, posted or not.
  it('a typed answer takes the open choice’s own forms even before their ts are filled', () => {
    const base = { sessionKey: KEY, channel: 'C1', threadTs: 'root', selections: {}, createdAt: Date.now() };
    formStore.set('form-a', { ...base, formId: 'form-a', messageTs: '', questions: [] });
    formStore.set('form-b', { ...base, formId: 'form-b', messageTs: '', questions: [] });
    formStore.set('form-other', { ...base, formId: 'form-other', messageTs: '', questions: [] });

    expect(handler.takeAnsweredForms(KEY, ['form-a', 'form-b'])).toBe(2);
    expect(formStore.get('form-a')).toBeUndefined();
    expect(formStore.get('form-b')).toBeUndefined();
    expect(formStore.get('form-other')).toBeDefined();
    // The renderer, when the posting ends, hears the question was answered meanwhile.
    expect(handler.formsAnswered(KEY, ['form-a', 'form-b'])).toBe(true);
    expect(handler.formsAnswered(KEY, ['form-other'])).toBe(false);
  });

  it('a given-back form answer puts the form back in the store and its message gets its buttons back', async () => {
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
    slackWrite.release();
    messageHandler.mockRejectedValueOnce(new AnswerNotKeptError('persist_failed'));

    await handler.handleFormSubmit({
      actions: [{ value: JSON.stringify({ formId: 'form-1', sessionKey: KEY }) }],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'form-ts' },
    });

    expect(formStore.get('form-1')).toMatchObject({ formId: 'form-1', submitting: false });
    await vi.waitFor(() =>
      expect(slackApi.updateMessage).toHaveBeenCalledWith(
        'C1',
        'form-ts',
        '📋 선택이 필요합니다',
        undefined,
        expect.any(Array),
      ),
    );
    expect(session.actionPanel.pendingQuestion).toBe(QUESTION);
  });

  it('an answer to a question recorded on an idle session (a goal decision) is given back idle', async () => {
    session.activityState = 'idle';
    session.actionPanel.waitingForChoice = false;
    slackWrite.release();
    messageHandler.mockRejectedValueOnce(new AnswerNotKeptError('capacity'));

    await expect(handler.handleChoiceFromDashboard(KEY, '1', '진행', QUESTION.question, 'U1')).rejects.toThrow(
      AnswerNotKeptError,
    );

    expect(session.activityState).toBe('idle');
    expect(session.actionPanel.pendingQuestion).toBe(QUESTION);
  });

  it('an answer given back, then answered again before Slack drew either: the card ends drawn as answered', async () => {
    messageHandler.mockRejectedValueOnce(new AnswerNotKeptError('capacity'));
    await handler.handleUserChoice(button('1')); // refused: given back, its draw-back waits behind the drawing
    const answeringAgain = handler.handleUserChoice(button('2')); // the owner answers again at once
    await Promise.resolve();
    expect(messageHandler).toHaveBeenCalledTimes(2);

    slackWrite.release();
    await answeringAgain;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Two answered drawings and no draw-back over the second: the card reads the answer the session took.
    const drawn = slackApi.updateMessage.mock.calls.map((call: any[]) => String(call[2]));
    expect(drawn).toHaveLength(2);
    expect(drawn.every((text: string) => text.startsWith('✅'))).toBe(true);
    expect(session.actionPanel.pendingQuestion).toBeUndefined();
  });

  it('two chunks of a split form refused together both come back to the record', async () => {
    session.actionPanel.pendingChoice = { kind: 'multi', turnId: 'turn-1', formIds: ['form-a', 'form-b'] };
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
    const refusals = [deferred(), deferred()];
    let call = 0;
    messageHandler.mockImplementation(() => {
      const refusal = refusals[call++];
      return refusal.promise.then(() => {
        throw new AnswerNotKeptError('capacity');
      });
    });
    const submit = (formId: string, ts: string) =>
      handler.handleFormSubmit({
        actions: [{ value: JSON.stringify({ formId, sessionKey: KEY }) }],
        user: { id: 'U1' },
        channel: { id: 'C1' },
        message: { ts },
      });

    const a = submit('form-a', 'ts-a');
    await Promise.resolve();
    const b = submit('form-b', 'ts-b'); // the last chunk: it closes the question
    await Promise.resolve();
    expect(session.actionPanel.pendingQuestion).toBeUndefined();

    refusals[0].release();
    await a;
    refusals[1].release();
    await b;

    expect(session.actionPanel.pendingQuestion).toBe(QUESTION);
    expect([...session.actionPanel.pendingChoice.formIds].sort()).toEqual(['form-a', 'form-b']);
    expect(formStore.get('form-a')).toBeDefined();
    expect(formStore.get('form-b')).toBeDefined();
  });

  it('after one chunk answered from Slack, the dashboard answers the rest', async () => {
    const multi = {
      type: 'user_choices' as const,
      questions: [
        { id: 'qa', question: 'A?', choices: [{ id: '1', label: 'A' }] },
        { id: 'qb', question: 'B?', choices: [{ id: '1', label: 'B' }] },
      ],
    };
    session.actionPanel = {
      waitingForChoice: true,
      pendingQuestion: multi,
      choiceMessageTs: 'ts-a',
      pendingChoice: { kind: 'multi', turnId: 'turn-1', formIds: ['form-a', 'form-b'] },
    };
    for (const [formId, ts, qid] of [
      ['form-a', 'ts-a', 'qa'],
      ['form-b', 'ts-b', 'qb'],
    ] as const) {
      formStore.set(formId, {
        formId,
        sessionKey: KEY,
        channel: 'C1',
        threadTs: 'root',
        messageTs: ts,
        turnId: 'turn-1',
        questions: [multi.questions.find((q) => q.id === qid)],
        selections: { [qid]: { choiceId: '1', label: 'A' } },
        createdAt: Date.now(),
      });
    }
    slackWrite.release();
    await handler.handleFormSubmit({
      actions: [{ value: JSON.stringify({ formId: 'form-a', sessionKey: KEY }) }],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'ts-a' },
    });

    // The dashboard sends what is still open: chunk B alone is enough, and chunk A is not sent to the model again.
    await handler.handleMultiChoiceFromDashboard(KEY, { qb: { choiceId: '1', label: 'B' } }, 'U1');

    expect(messageHandler).toHaveBeenCalledTimes(2);
    const second = String(messageHandler.mock.calls[1][0].text);
    expect(second).toContain('B?');
    expect(second).not.toContain('A?');
    expect(session.actionPanel.pendingQuestion).toBeUndefined();
  });

  it('the dashboard answers the open chunks while the answered chunk’s turn still runs (round 6, astra)', async () => {
    const multi = {
      type: 'user_choices' as const,
      questions: [
        { id: 'qa', question: 'A?', choices: [{ id: '1', label: 'A' }] },
        { id: 'qb', question: 'B?', choices: [{ id: '1', label: 'B' }] },
      ],
    };
    session.actionPanel = {
      waitingForChoice: true,
      pendingQuestion: multi,
      pendingChoice: { kind: 'multi', turnId: 'turn-1', formIds: ['form-a', 'form-b'] },
    };
    for (const [formId, ts, qid] of [
      ['form-a', 'ts-a', 'qa'],
      ['form-b', 'ts-b', 'qb'],
    ] as const) {
      formStore.set(formId, {
        formId,
        sessionKey: KEY,
        channel: 'C1',
        threadTs: 'root',
        messageTs: ts,
        turnId: 'turn-1',
        questions: [multi.questions.find((q) => q.id === qid)],
        selections: { [qid]: { choiceId: '1', label: 'A' } },
        createdAt: Date.now(),
      });
    }
    slackWrite.release();
    const chunkTurn = deferred();
    messageHandler.mockImplementationOnce(() => chunkTurn.promise); // chunk A's turn runs (its submit holds A)
    const submittingA = handler.handleFormSubmit({
      actions: [{ value: JSON.stringify({ formId: 'form-a', sessionKey: KEY }) }],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'ts-a' },
    });
    await Promise.resolve();

    await handler.handleMultiChoiceFromDashboard(KEY, { qb: { choiceId: '1', label: 'B' } }, 'U1');

    expect(messageHandler).toHaveBeenCalledTimes(2);
    chunkTurn.release();
    await submittingA;
  });

  it('a form selection whose edit waits while a typed reply answers the question does not raise it again', async () => {
    session.actionPanel = { waitingForChoice: true, pendingQuestion: QUESTION, choiceMessageTs: 'form-ts' };
    formStore.set('form-1', {
      formId: 'form-1',
      sessionKey: KEY,
      channel: 'C1',
      threadTs: 'root',
      messageTs: 'form-ts',
      questions: [{ id: 'q1', question: 'Q1?', choices: [{ id: '1', label: 'A' }] }],
      selections: {},
      createdAt: Date.now(),
    });
    const attachChoice = vi.fn(async () => {
      session.actionPanel.waitingForChoice = true;
    });
    (handler as any).ctx.threadPanel.attachChoice = attachChoice;
    const selecting = handler.handleMultiChoice({
      actions: [
        { value: JSON.stringify({ formId: 'form-1', sessionKey: KEY, questionId: 'q1', choiceId: '1', label: 'A' }) },
      ],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'form-ts' },
    });
    await Promise.resolve();
    // The owner's typed reply is recorded as the answer (SlackHandler.recordTypedAnswer): the question leaves.
    session.actionPanel = {};
    slackWrite.release();
    await selecting;

    expect(attachChoice).not.toHaveBeenCalled();
    expect(session.actionPanel.waitingForChoice).toBeUndefined();
  });

  it('a form selection whose edit waits while the dashboard answers does not raise the answered question again', async () => {
    const multi = {
      type: 'user_choices' as const,
      questions: [{ id: 'q1', question: 'Q1?', choices: [{ id: '1', label: 'A' }] }],
    };
    session.actionPanel = { waitingForChoice: true, pendingQuestion: multi, choiceMessageTs: 'form-ts' };
    formStore.set('form-1', {
      formId: 'form-1',
      sessionKey: KEY,
      channel: 'C1',
      threadTs: 'root',
      messageTs: 'form-ts',
      questions: multi.questions,
      selections: {},
      createdAt: Date.now(),
    });
    const attachChoice = vi.fn(async () => {
      session.actionPanel.waitingForChoice = true; // what the real attach does
    });
    (handler as any).ctx.threadPanel.attachChoice = attachChoice;

    const selecting = handler.handleMultiChoice({
      actions: [
        { value: JSON.stringify({ formId: 'form-1', sessionKey: KEY, questionId: 'q1', choiceId: '1', label: 'A' }) },
      ],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'form-ts' },
    });
    await Promise.resolve();
    const answering = handler.handleMultiChoiceFromDashboard(KEY, { q1: { choiceId: '1', label: 'A' } }, 'U1');
    await Promise.resolve();
    slackWrite.release();
    await Promise.all([selecting, answering]);

    expect(attachChoice).not.toHaveBeenCalled();
    expect(session.actionPanel.waitingForChoice).toBe(false);
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
