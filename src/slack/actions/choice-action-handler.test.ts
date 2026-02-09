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
  let actionPanelManager: any;
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
    actionPanelManager = {
      clearChoice: vi.fn().mockResolvedValue(undefined),
      attachChoice: vi.fn().mockResolvedValue(undefined),
    };

    handler = new ChoiceActionHandler(
      {
        slackApi,
        claudeHandler,
        messageHandler,
        actionPanelManager,
      } as any,
      formStore as any
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

    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'thread-choice-message-ts',
      expect.any(String),
      expect.any(Array)
    );

    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: 'thread-root',
        ts: 'panel-message-ts',
        text: '2',
      }),
      expect.any(Function)
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

    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'thread-form-message-ts',
      expect.any(String),
      expect.any(Array)
    );

    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: 'thread-root',
      }),
      expect.any(Function)
    );
  });
});
