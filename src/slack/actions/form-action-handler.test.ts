import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FormActionHandler } from './form-action-handler';

describe('FormActionHandler', () => {
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let actionPanelManager: any;
  let formStore: any;
  let choiceHandler: any;
  let handler: FormActionHandler;

  beforeEach(() => {
    slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
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
    formStore = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };
    choiceHandler = {
      completeMultiChoiceForm: vi.fn().mockResolvedValue(undefined),
    };

    handler = new FormActionHandler(
      {
        slackApi,
        claudeHandler,
        messageHandler,
        actionPanelManager,
      } as any,
      formStore as any,
      choiceHandler as any
    );
  });

  it('uses session thread for custom-input modal when action panel message is root-level', async () => {
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
    });
    const client = {
      views: {
        open: vi.fn().mockResolvedValue(undefined),
      },
    };
    const body = {
      trigger_id: 'trigger-1',
      actions: [
        {
          value: JSON.stringify({
            sessionKey: 'C123:thread-root',
            question: '상세 내용을 입력해 주세요',
            type: 'single',
          }),
        },
      ],
      channel: { id: 'C123' },
      message: { ts: 'panel-message-ts' },
    };

    await handler.handleCustomInputSingle(body, client);

    expect(client.views.open).toHaveBeenCalledTimes(1);
    const call = client.views.open.mock.calls[0][0];
    const metadata = JSON.parse(call.view.private_metadata);
    expect(metadata.threadTs).toBe('thread-root');
    expect(metadata.messageTs).toBe('panel-message-ts');
  });

  it('syncs single custom-input completion to the in-thread choice message', async () => {
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {
        choiceMessageTs: 'thread-choice-message-ts',
      },
    });

    const body = {
      user: { id: 'U123' },
    };

    const view = {
      private_metadata: JSON.stringify({
        sessionKey: 'C123:thread-root',
        question: '상세 내용을 입력해 주세요',
        channel: 'C123',
        messageTs: 'panel-message-ts',
        threadTs: 'panel-message-ts',
        type: 'single',
      }),
      state: {
        values: {
          custom_input_block: {
            custom_input_text: {
              value: '직접 입력 답변',
            },
          },
        },
      },
    };

    await handler.handleCustomInputSubmit(body, view);

    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      'thread-choice-message-ts',
      expect.any(String),
      expect.any(Array)
    );
  });
});
