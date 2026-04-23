import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config';
import { FormActionHandler } from './form-action-handler';

describe('FormActionHandler', () => {
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let threadPanel: any;
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
    threadPanel = {
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
        threadPanel,
      } as any,
      formStore as any,
      choiceHandler as any,
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
  });

  it('syncs multi custom-input updates to both panel and thread form messages', async () => {
    const pendingForm = {
      formId: 'form-1',
      sessionKey: 'C123:thread-root',
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
    };
    formStore.get.mockReturnValue(pendingForm);
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {
        choiceMessageTs: 'thread-form-message-ts',
      },
    });

    const body = {
      user: { id: 'U123' },
    };

    const view = {
      private_metadata: JSON.stringify({
        sessionKey: 'C123:thread-root',
        question: '어떤 전략으로 진행할까요?',
        channel: 'C123',
        messageTs: 'panel-message-ts',
        threadTs: 'thread-root',
        type: 'multi',
        formId: 'form-1',
        questionId: 'q1',
      }),
      state: {
        values: {
          custom_input_block: {
            custom_input_text: {
              value: '직접 입력으로 세부 전략 제시',
            },
          },
        },
      },
    };

    await handler.handleCustomInputSubmit(body, view);

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

describe('FormActionHandler — P3 (PHASE>=3) classifyClick', () => {
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let threadPanel: any;
  let formStore: any;
  let choiceHandler: any;
  let sessionRegistry: any;
  let handler: FormActionHandler;
  const sessionKey = 'C1:thread-root';

  beforeEach(() => {
    slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
    };
    sessionRegistry = { persistAndBroadcast: vi.fn() };
    claudeHandler = {
      getSessionByKey: vi.fn(),
      setActivityStateByKey: vi.fn(),
      getSessionRegistry: vi.fn(() => sessionRegistry),
    };
    messageHandler = vi.fn().mockResolvedValue(undefined);
    threadPanel = {
      clearChoice: vi.fn().mockResolvedValue(undefined),
      attachChoice: vi.fn().mockResolvedValue(undefined),
      resolveChoice: vi.fn().mockResolvedValue(true),
      resolveMultiChoice: vi.fn().mockResolvedValue(true),
    };
    formStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    choiceHandler = { completeMultiChoiceForm: vi.fn().mockResolvedValue(undefined) };
    handler = new FormActionHandler(
      { slackApi, claudeHandler, messageHandler, threadPanel } as any,
      formStore,
      choiceHandler as any,
    );
  });

  afterEach(() => {
    config.ui.fiveBlockPhase = 0;
  });

  it('handleCustomInputSingle inherits turnId into private_metadata', async () => {
    config.ui.fiveBlockPhase = 3;
    claudeHandler.getSessionByKey.mockReturnValue({ threadRootTs: 'tr', threadTs: 'tr' });
    const views = { open: vi.fn().mockResolvedValue(undefined) };
    const client = { views };
    const body = {
      trigger_id: 'trig',
      actions: [
        {
          value: JSON.stringify({ sessionKey, question: 'Q', type: 'single', turnId: 't1' }),
        },
      ],
      channel: { id: 'C1' },
      message: { ts: 'msg-1' },
    };
    await handler.handleCustomInputSingle(body, client);
    const view = views.open.mock.calls[0][0].view;
    const pm = JSON.parse(view.private_metadata);
    expect(pm.turnId).toBe('t1');
  });

  it('handleCustomInputSubmit single P3 stale → marks message and no dispatch', async () => {
    config.ui.fiveBlockPhase = 3;
    claudeHandler.getSessionByKey.mockReturnValue({
      channelId: 'C1',
      threadRootTs: 'tr',
      threadTs: 'tr',
      actionPanel: { pendingChoice: { turnId: 'tOTHER', kind: 'single', choiceTs: 'msg-1', formIds: [] } },
    });
    const body = { user: { id: 'U1' } };
    const view = {
      private_metadata: JSON.stringify({
        sessionKey,
        question: 'Q',
        channel: 'C1',
        messageTs: 'msg-1',
        threadTs: 'tr',
        type: 'single',
        turnId: 't1',
      }),
      state: { values: { custom_input_block: { custom_input_text: { value: 'hello' } } } },
    };
    await handler.handleCustomInputSubmit(body, view);
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'msg-1',
      expect.stringContaining('더 이상 유효하지 않습니다'),
      expect.any(Array),
      [],
    );
    expect(messageHandler).not.toHaveBeenCalled();
    expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
  });

  it('handleCustomInputSubmit single P3 matching → resolveChoice + dispatch', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = {
      channelId: 'C1',
      threadRootTs: 'tr',
      threadTs: 'tr',
      actionPanel: {
        pendingChoice: { turnId: 't1', kind: 'single', choiceTs: 'msg-1', formIds: [] },
        pendingQuestion: { type: 'user_choice' },
      },
    };
    claudeHandler.getSessionByKey.mockReturnValue(session);
    const body = { user: { id: 'U1' } };
    const view = {
      private_metadata: JSON.stringify({
        sessionKey,
        question: 'Q',
        channel: 'C1',
        messageTs: 'msg-1',
        threadTs: 'tr',
        type: 'single',
        turnId: 't1',
      }),
      state: { values: { custom_input_block: { custom_input_text: { value: 'hello' } } } },
    };
    await handler.handleCustomInputSubmit(body, view);
    expect(threadPanel.resolveChoice).toHaveBeenCalledWith(
      session,
      sessionKey,
      'C1',
      expect.any(String),
      expect.any(Array),
    );
    expect(messageHandler).toHaveBeenCalled();
    expect(session.actionPanel.pendingQuestion).toBeUndefined();
  });

  it('multi custom-input P3 stale → marks message and no dispatch', async () => {
    config.ui.fiveBlockPhase = 3;
    formStore.get.mockReturnValue({
      formId: 'f1',
      sessionKey,
      questions: [{ id: 'q1', question: 'Q1', choices: [] }],
      selections: {},
      messageTs: 'msg-f',
      turnId: 'tOTHER',
      createdAt: Date.now(),
      channel: 'C1',
      threadTs: 'tr',
    });
    claudeHandler.getSessionByKey.mockReturnValue({
      channelId: 'C1',
      threadRootTs: 'tr',
      threadTs: 'tr',
      actionPanel: { pendingChoice: { turnId: 't1', kind: 'multi', choiceTs: 'msg-f', formIds: ['f1'] } },
    });
    const body = { user: { id: 'U1' } };
    const view = {
      private_metadata: JSON.stringify({
        sessionKey,
        question: 'Q1',
        channel: 'C1',
        messageTs: 'msg-1',
        threadTs: 'tr',
        type: 'multi',
        formId: 'f1',
        questionId: 'q1',
      }),
      state: { values: { custom_input_block: { custom_input_text: { value: 'custom-answer' } } } },
    };
    await handler.handleCustomInputSubmit(body, view);
    // stale branch: marks msg-1 stale; no selection stored on form; no completion call
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'msg-1',
      expect.stringContaining('더 이상 유효하지 않습니다'),
      expect.any(Array),
      [],
    );
    expect(choiceHandler.completeMultiChoiceForm).not.toHaveBeenCalled();
  });
});
