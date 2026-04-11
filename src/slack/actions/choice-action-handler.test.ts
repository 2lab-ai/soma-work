import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChoiceActionHandler } from './choice-action-handler';

function createFormStore() {
  const forms = new Map<string, any>();
  return {
    get(formId: string) {
      return forms.get(formId);
    },
    set(formId: string, data: any) {
      forms.set(formId, data);
    },
    delete(formId: string) {
      forms.delete(formId);
    },
  };
}

describe('ChoiceActionHandler', () => {
  let formStore: ReturnType<typeof createFormStore>;
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let threadPanel: any;
  let handler: ChoiceActionHandler;

  beforeEach(() => {
    formStore = createFormStore();
    slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
    };
    claudeHandler = {
      getSessionByKey: vi.fn(),
      setActivityStateByKey: vi.fn(),
    };
    messageHandler = vi.fn().mockResolvedValue(undefined);
    threadPanel = {
      clearChoice: vi.fn().mockResolvedValue(undefined),
      attachChoice: vi.fn().mockResolvedValue(undefined),
    };

    handler = new ChoiceActionHandler(
      {
        slackApi,
        claudeHandler,
        messageHandler,
        threadPanel,
      } as any,
      formStore as any,
    );
  });

  it('routes single-choice submit to the existing session thread', async () => {
    const sessionKey = 'C123:thread-root';
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {
        choiceMessageTs: 'thread-choice-message-ts',
      },
    });

    const body = {
      actions: [
        {
          value: JSON.stringify({
            sessionKey,
            choiceId: '2',
            label: '미확인 사항 먼저 답변',
            question: '다음 단계로 무엇을 진행할까요?',
          }),
        },
      ],
      user: { id: 'U123' },
      channel: { id: 'C123' },
      message: { ts: 'panel-message-ts' },
    };

    await handler.handleUserChoice(body);

    // 모든 동기화 대상에 대해 attachments: [] 포함하여 업데이트
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'thread-choice-message-ts',
      expect.any(String),
      expect.any(Array),
      [], // 기존 attachments(버튼) 제거
    );
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'panel-message-ts',
      expect.any(String),
      expect.any(Array),
      [], // 기존 attachments(버튼) 제거
    );

    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: 'thread-root',
        ts: 'panel-message-ts',
        text: '2',
      }),
      expect.any(Function),
    );
  });

  it('routes multi-choice form submit to the existing session thread', async () => {
    const sessionKey = 'C123:thread-root';
    formStore.set('form-1', {
      formId: 'form-1',
      sessionKey,
      channel: 'C123',
      threadTs: 'thread-root',
      messageTs: 'thread-form-message-ts',
      questions: [
        {
          id: 'q1',
          question: '어떤 전략으로 진행할까요?',
          choices: [{ id: '1', label: '빠른 수정' }],
        },
      ],
      selections: {
        q1: {
          choiceId: '1',
          label: '빠른 수정',
        },
      },
      createdAt: Date.now(),
    });

    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
    });

    const body = {
      actions: [
        {
          value: JSON.stringify({
            formId: 'form-1',
            sessionKey,
          }),
        },
      ],
      user: { id: 'U123' },
      channel: { id: 'C123' },
      message: { ts: 'panel-message-ts' },
    };

    await handler.handleFormSubmit(body);

    // 모든 동기화 대상에 대해 attachments: [] 포함하여 업데이트
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'thread-form-message-ts',
      expect.any(String),
      expect.any(Array),
      [], // 기존 attachments(버튼 폼) 제거
    );
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'panel-message-ts',
      expect.any(String),
      expect.any(Array),
      [], // 기존 attachments(버튼 폼) 제거
    );

    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: 'thread-root',
      }),
      expect.any(Function),
    );
  });

  it('rolls back session to waiting when messageHandler throws in handleUserChoice', async () => {
    const sessionKey = 'C123:thread-root';
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      channelId: 'C123',
      actionPanel: {
        choiceMessageTs: 'thread-choice-message-ts',
      },
    });

    messageHandler.mockRejectedValueOnce(new TypeError('Cannot read properties of undefined'));

    const body = {
      actions: [
        {
          value: JSON.stringify({
            sessionKey,
            choiceId: '1',
            label: 'Option A',
            question: 'Pick one?',
          }),
        },
      ],
      user: { id: 'U123' },
      channel: { id: 'C123' },
      message: { ts: 'panel-message-ts' },
    };

    await handler.handleUserChoice(body);

    // Should have been set to 'working' first, then rolled back to 'waiting'
    expect(claudeHandler.setActivityStateByKey).toHaveBeenCalledWith(sessionKey, 'working');
    expect(claudeHandler.setActivityStateByKey).toHaveBeenCalledWith(sessionKey, 'waiting');
    // The last call should be the rollback to 'waiting'
    const calls = claudeHandler.setActivityStateByKey.mock.calls;
    expect(calls[calls.length - 1]).toEqual([sessionKey, 'waiting']);
  });

  it('uses session.channelId as fallback when body.channel is undefined in handleUserChoice', async () => {
    const sessionKey = 'C123:thread-root';
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      channelId: 'C123',
      actionPanel: {
        choiceMessageTs: 'thread-choice-message-ts',
      },
    });

    const body = {
      actions: [
        {
          value: JSON.stringify({
            sessionKey,
            choiceId: '2',
            label: 'Option B',
            question: 'Pick one?',
          }),
        },
      ],
      user: { id: 'U123' },
      // No channel property — simulates the bug scenario
      message: { ts: 'panel-message-ts' },
    };

    await handler.handleUserChoice(body);

    // Should still call messageHandler using the session's channelId
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: 'thread-root',
        text: '2',
      }),
      expect.any(Function),
    );
  });

  it('rolls back session to waiting when messageHandler throws in completeMultiChoiceForm', async () => {
    const sessionKey = 'C123:thread-root';
    const pendingForm = {
      formId: 'form-rollback',
      sessionKey,
      channel: 'C123',
      threadTs: 'thread-root',
      messageTs: 'thread-form-message-ts',
      questions: [
        {
          id: 'q1',
          question: 'Strategy?',
          choices: [{ id: '1', label: 'Quick fix' }],
        },
      ],
      selections: {
        q1: { choiceId: '1', label: 'Quick fix' },
      },
      createdAt: Date.now(),
    };

    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      channelId: 'C123',
      actionPanel: {},
    });

    messageHandler.mockRejectedValueOnce(new Error('messageHandler exploded'));

    await handler.completeMultiChoiceForm(pendingForm as any, 'U123', 'C123', 'thread-root', 'panel-message-ts');

    // Should have been set to 'working' first, then rolled back to 'waiting'
    expect(claudeHandler.setActivityStateByKey).toHaveBeenCalledWith(sessionKey, 'working');
    expect(claudeHandler.setActivityStateByKey).toHaveBeenCalledWith(sessionKey, 'waiting');
    const calls = claudeHandler.setActivityStateByKey.mock.calls;
    expect(calls[calls.length - 1]).toEqual([sessionKey, 'waiting']);
  });

  it('syncs panel multi-choice selection back to thread choice message', async () => {
    const sessionKey = 'C123:thread-root';
    formStore.set('form-2', {
      formId: 'form-2',
      sessionKey,
      channel: 'C123',
      threadTs: 'thread-root',
      messageTs: 'thread-form-message-ts',
      questions: [
        {
          id: 'q1',
          question: '어떤 전략으로 진행할까요?',
          choices: [{ id: '1', label: '빠른 수정' }],
        },
      ],
      selections: {},
      createdAt: Date.now(),
    });

    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {
        choiceMessageTs: 'thread-form-message-ts',
      },
    });

    const body = {
      actions: [
        {
          value: JSON.stringify({
            formId: 'form-2',
            sessionKey,
            questionId: 'q1',
            choiceId: '1',
            label: '빠른 수정',
          }),
        },
      ],
      user: { id: 'U123' },
      channel: { id: 'C123' },
      message: { ts: 'panel-message-ts' },
    };

    await handler.handleMultiChoice(body);

    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'panel-message-ts',
      expect.any(String),
      undefined,
      expect.any(Array),
    );
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'thread-form-message-ts',
      expect.any(String),
      undefined,
      expect.any(Array),
    );
  });
});
