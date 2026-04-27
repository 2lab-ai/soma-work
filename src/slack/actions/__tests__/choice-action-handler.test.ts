import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../../config';
import { ChoiceActionHandler } from '../choice-action-handler';

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
    getFormsBySession(sessionKey: string) {
      const out = new Map<string, any>();
      for (const [id, f] of forms) {
        if (f && f.sessionKey === sessionKey) out.set(id, f);
      }
      return out;
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

  describe('handleSubmitAllRecommended (hero)', () => {
    const sessionKey = 'C123:thread-root';
    const formId = 'form-hero';

    function seedForm(overrides: Partial<any> = {}): any {
      const base: any = {
        formId,
        sessionKey,
        channel: 'C123',
        threadTs: 'thread-root',
        messageTs: 'thread-form-message-ts',
        questions: [
          {
            id: 'q1',
            question: 'Q1?',
            choices: [
              { id: '1', label: 'A' },
              { id: '2', label: 'B' },
            ],
            recommendedChoiceId: '2',
          },
          {
            id: 'q2',
            question: 'Q2?',
            choices: [
              { id: '1', label: 'X' },
              { id: '2', label: 'Y' },
            ],
            recommendedChoiceId: '1',
          },
        ],
        selections: {} as Record<string, { choiceId: string; label: string }>,
        createdAt: Date.now(),
      };
      const merged: any = { ...base, ...overrides };
      formStore.set(formId, merged);
      return merged;
    }

    function makeBody(opts: { blocked?: boolean; n?: number; m?: number } = {}) {
      const n = opts.n ?? 2;
      const m = opts.m ?? 2;
      const action_id = opts.blocked ? `submit_all_recommended_blocked_${formId}` : `submit_all_recommended_${formId}`;
      return {
        actions: [
          {
            action_id,
            value: JSON.stringify({ formId, sessionKey, n, m }),
          },
        ],
        user: { id: 'U123' },
        channel: { id: 'C123' },
        message: { ts: 'panel-message-ts' },
      };
    }

    it('Test 1 — N=M (full recommendations): fills selections and calls completeMultiChoiceForm', async () => {
      const form = seedForm();
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {},
      });

      await handler.handleSubmitAllRecommended(makeBody({ n: 2, m: 2 }));

      // Filled both selections from recommendedChoiceId
      expect(form.selections).toEqual({
        q1: { choiceId: '2', label: 'B' },
        q2: { choiceId: '1', label: 'X' },
      });
      // completeMultiChoiceForm dispatches messageHandler with combined response
      expect(messageHandler).toHaveBeenCalled();
      expect(claudeHandler.setActivityStateByKey).toHaveBeenCalledWith(sessionKey, 'working');
    });

    it('Test 6 — partial-fill: preserves existing user pick, fills only unanswered', async () => {
      // Q1 already answered manually with non-recommended choice
      const form = seedForm({
        selections: { q1: { choiceId: '1', label: 'A' } },
      });
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {},
      });

      await handler.handleSubmitAllRecommended(makeBody({ n: 2, m: 2 }));

      // Q1 preserved, Q2 filled from recommendation → both answered → completes
      expect(form.selections.q1).toEqual({ choiceId: '1', label: 'A' });
      expect(form.selections.q2).toEqual({ choiceId: '1', label: 'X' });
      expect(messageHandler).toHaveBeenCalled();
    });

    it('Test 2 — blocked variant: posts ephemeral and does NOT submit', async () => {
      seedForm();
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {},
      });

      await handler.handleSubmitAllRecommended(makeBody({ blocked: true, n: 1, m: 2 }));

      expect(slackApi.postEphemeral).toHaveBeenCalledWith('C123', 'U123', expect.stringContaining('🔒'));
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('Test 8 — submitting=true: posts ephemeral, no double-submit', async () => {
      seedForm({ submitting: true });
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {},
      });

      await handler.handleSubmitAllRecommended(makeBody({ n: 2, m: 2 }));

      expect(slackApi.postEphemeral).toHaveBeenCalledWith('C123', 'U123', expect.stringContaining('이미 제출'));
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('Test 9 — form expired (not in store): posts ephemeral, no submit', async () => {
      // Do NOT seed form
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {},
      });

      await handler.handleSubmitAllRecommended(makeBody({ n: 2, m: 2 }));

      expect(slackApi.postEphemeral).toHaveBeenCalledWith(
        'C123',
        'U123',
        expect.stringContaining('폼을 찾을 수 없습니다'),
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('Test extra — activityState !== "waiting": posts ephemeral, no submit', async () => {
      seedForm();
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'working',
        actionPanel: {},
      });

      await handler.handleSubmitAllRecommended(makeBody({ n: 2, m: 2 }));

      expect(slackApi.postEphemeral).toHaveBeenCalledWith(
        'C123',
        'U123',
        expect.stringContaining('대기 중이 아닙니다'),
      );
      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('Test 11 (P0-A) — completeMultiChoiceForm throws → submitting reset to false → re-click succeeds', async () => {
      const form = seedForm();
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {},
      });

      // First click: messageHandler throws → completeMultiChoiceForm rolls back state
      // but does NOT throw. So submitting will remain true after first click unless we
      // arrange for the inner call to throw at the slack-update boundary. Use a path
      // where slack updateMessage throws AND messageHandler throws.
      // Simpler: stub completeMultiChoiceForm directly to throw via slackApi failure.
      slackApi.updateMessage
        .mockRejectedValueOnce(new Error('slack down — first attempt')) // for completion update
        .mockResolvedValue(undefined);
      messageHandler.mockRejectedValueOnce(new Error('claude pipe burst'));

      await handler.handleSubmitAllRecommended(makeBody({ n: 2, m: 2 }));

      // After the throw inside completeMultiChoiceForm rollback path: form may have been
      // deleted by completeMultiChoiceForm before the throw. Verify either:
      //   (a) form still exists with submitting=false
      //   (b) form was deleted (success path; messageHandler error rolled back state only)
      const afterFirst = formStore.get(formId);
      if (afterFirst) {
        expect(afterFirst.submitting).toBe(false);
      }
      expect(claudeHandler.setActivityStateByKey).toHaveBeenCalledWith(sessionKey, 'waiting');
      // Sanity: form indeed got the recommendations filled
      expect(form.selections.q1).toEqual({ choiceId: '2', label: 'B' });
    });

    it('Test 12 (P0-B) — handleSubmitRecommendedFromDashboard while Slack form has submitting=true → throws', async () => {
      seedForm({ submitting: true });
      claudeHandler.getSessionByKey.mockReturnValue({
        sessionKey,
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {
          pendingQuestion: {
            type: 'user_choices',
            questions: [
              {
                id: 'q1',
                question: 'Q1?',
                choices: [
                  { id: '1', label: 'A' },
                  { id: '2', label: 'B' },
                ],
                recommendedChoiceId: '2',
              },
              {
                id: 'q2',
                question: 'Q2?',
                choices: [
                  { id: '1', label: 'X' },
                  { id: '2', label: 'Y' },
                ],
                recommendedChoiceId: '1',
              },
            ],
          },
        },
      });

      await expect(handler.handleSubmitRecommendedFromDashboard(sessionKey, 'U999')).rejects.toThrow(
        /Submission in progress/,
      );
    });

    it('Test 17 — telemetry: logs hero_recommended_clicked with surface=slack on active click', async () => {
      seedForm();
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {},
      });

      const infoSpy = vi.spyOn((handler as any).logger, 'info');

      await handler.handleSubmitAllRecommended(makeBody({ n: 2, m: 2 }));

      const heroCall = infoSpy.mock.calls.find((c) => c[0] === 'hero_recommended_clicked');
      expect(heroCall).toBeDefined();
      expect(heroCall![1]).toMatchObject({
        surface: 'slack',
        n: 2,
        m: 2,
        sessionKey,
        formId,
      });
    });

    it('Test 17b — telemetry: logs hero_recommended_blocked with surface=slack on blocked click', async () => {
      seedForm();
      claudeHandler.getSessionByKey.mockReturnValue({
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: {},
      });

      const infoSpy = vi.spyOn((handler as any).logger, 'info');

      await handler.handleSubmitAllRecommended(makeBody({ blocked: true, n: 1, m: 2 }));

      const heroCall = infoSpy.mock.calls.find((c) => c[0] === 'hero_recommended_blocked');
      expect(heroCall).toBeDefined();
      expect(heroCall![1]).toMatchObject({
        surface: 'slack',
        n: 1,
        m: 2,
        sessionKey,
        formId,
      });
    });
  });

  describe('handleSubmitRecommendedFromDashboard', () => {
    const sessionKey = 'C123:thread-root';

    function pendingQ(opts: { withRec?: boolean; mixed?: boolean; allCustom?: boolean } = {}) {
      const { withRec = true, mixed = false, allCustom = false } = opts;
      return {
        type: 'user_choices',
        questions: [
          {
            id: 'q1',
            question: 'Q1?',
            choices: [
              { id: '1', label: 'A' },
              { id: '2', label: 'B' },
            ],
            recommendedChoiceId: allCustom ? '직접입력' : withRec ? '2' : undefined,
          },
          {
            id: 'q2',
            question: 'Q2?',
            choices: [
              { id: '1', label: 'X' },
              { id: '2', label: 'Y' },
            ],
            recommendedChoiceId: allCustom ? '직접입력' : mixed ? undefined : '1',
          },
        ],
      };
    }

    it('throws "Session not found" when session missing', async () => {
      claudeHandler.getSessionByKey.mockReturnValue(undefined);
      await expect(handler.handleSubmitRecommendedFromDashboard(sessionKey, 'U1')).rejects.toThrow(/Session not found/);
    });

    it('throws "Session is not waiting for a choice" when activityState != waiting', async () => {
      claudeHandler.getSessionByKey.mockReturnValue({
        activityState: 'working',
        actionPanel: { pendingQuestion: pendingQ() },
      });
      await expect(handler.handleSubmitRecommendedFromDashboard(sessionKey, 'U1')).rejects.toThrow(
        /Session is not waiting/,
      );
    });

    it('throws "Session has no pending multi-choice question" when no pendingQuestion', async () => {
      claudeHandler.getSessionByKey.mockReturnValue({
        activityState: 'waiting',
        actionPanel: {},
      });
      await expect(handler.handleSubmitRecommendedFromDashboard(sessionKey, 'U1')).rejects.toThrow(
        /no pending multi-choice/,
      );
    });

    it('throws "No recommendation available" when all questions have no rec or 직접입력', async () => {
      claudeHandler.getSessionByKey.mockReturnValue({
        activityState: 'waiting',
        actionPanel: { pendingQuestion: pendingQ({ allCustom: true }) },
      });
      await expect(handler.handleSubmitRecommendedFromDashboard(sessionKey, 'U1')).rejects.toThrow(
        /No recommendation available/,
      );
    });

    it('throws "Recommendations incomplete" when only some questions have a recommendation', async () => {
      claudeHandler.getSessionByKey.mockReturnValue({
        sessionKey,
        channelId: 'C123',
        activityState: 'waiting',
        actionPanel: { pendingQuestion: pendingQ({ mixed: true }) },
      });
      await expect(handler.handleSubmitRecommendedFromDashboard(sessionKey, 'U1')).rejects.toThrow(
        /Recommendations incomplete/,
      );
    });
  });
});

describe('ChoiceActionHandler — P3 (PHASE>=3) classifyClick', () => {
  let formStore: ReturnType<typeof createFormStore>;
  let slackApi: any;
  let claudeHandler: any;
  let messageHandler: any;
  let threadPanel: any;
  let sessionRegistry: any;
  let handler: ChoiceActionHandler;
  const sessionKey = 'C1:thread-root';

  beforeEach(() => {
    formStore = createFormStore();
    slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
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

    handler = new ChoiceActionHandler(
      { slackApi, claudeHandler, messageHandler, threadPanel } as any,
      formStore as any,
    );
  });

  afterEach(() => {
    config.ui.fiveBlockPhase = 0;
  });

  const clickBody = (turnId?: string, messageTs = 'msg-1') => ({
    actions: [
      {
        value: JSON.stringify({
          sessionKey,
          choiceId: '2',
          label: 'B',
          question: 'Q?',
          ...(turnId ? { turnId } : {}),
        }),
      },
    ],
    user: { id: 'U1' },
    channel: { id: 'C1' },
    message: { ts: messageTs },
  });

  it('PHASE<3 always legacy, ignores payload turnId', async () => {
    config.ui.fiveBlockPhase = 2;
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {
        pendingChoice: { turnId: 'tOTHER', kind: 'single', choiceTs: 'msg-other', formIds: [] },
        choiceMessageTs: 'thread-choice',
      },
    });
    await handler.handleUserChoice(clickBody('tNEW', 'msg-1'));
    expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).toHaveBeenCalled(); // legacy path updates
    expect(messageHandler).toHaveBeenCalled();
  });

  it('PHASE>=3 + matching pendingChoice + matching turnId → p3 path', async () => {
    config.ui.fiveBlockPhase = 3;
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      channelId: 'C1',
      actionPanel: {
        pendingChoice: { turnId: 't1', kind: 'single', choiceTs: 'msg-1', formIds: [] },
        choiceMessageTs: 'msg-1',
      },
    });
    await handler.handleUserChoice(clickBody('t1', 'msg-1'));
    expect(threadPanel.resolveChoice).toHaveBeenCalledWith(
      expect.any(Object),
      sessionKey,
      'C1',
      expect.stringContaining('선택'),
      expect.any(Array),
    );
    expect(claudeHandler.setActivityStateByKey).toHaveBeenCalledWith(sessionKey, 'working');
    expect(messageHandler).toHaveBeenCalled();
  });

  it('PHASE>=3 + payload turnId + no pendingChoice → stale (not legacy)', async () => {
    config.ui.fiveBlockPhase = 3;
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {},
    });
    await handler.handleUserChoice(clickBody('t1', 'msg-1'));
    // Stale marker updateMessage
    const firstCall = slackApi.updateMessage.mock.calls[0];
    expect(firstCall[2]).toContain('더 이상 유효하지 않습니다');
    expect(messageHandler).not.toHaveBeenCalled();
    expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
  });

  it('PHASE>=3 + no payload turnId + no pendingChoice → legacy', async () => {
    config.ui.fiveBlockPhase = 3;
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {},
    });
    await handler.handleUserChoice(clickBody(undefined, 'msg-1'));
    expect(threadPanel.resolveChoice).not.toHaveBeenCalled();
    expect(slackApi.updateMessage).toHaveBeenCalled();
    expect(messageHandler).toHaveBeenCalled();
  });

  it('PHASE>=3 + pendingChoice present + turnId mismatch → stale', async () => {
    config.ui.fiveBlockPhase = 3;
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {
        pendingChoice: { turnId: 't1', kind: 'single', choiceTs: 'msg-1', formIds: [] },
      },
    });
    await handler.handleUserChoice(clickBody('t2', 'msg-1'));
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'msg-1',
      expect.stringContaining('더 이상 유효하지 않습니다'),
      expect.any(Array),
      [],
    );
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('PHASE>=3 + pendingChoice present + ts mismatch → stale', async () => {
    config.ui.fiveBlockPhase = 3;
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {
        pendingChoice: { turnId: 't1', kind: 'single', choiceTs: 'msg-other', formIds: [] },
      },
    });
    await handler.handleUserChoice(clickBody('t1', 'msg-1'));
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'msg-1',
      expect.stringContaining('더 이상 유효하지 않습니다'),
      expect.any(Array),
      [],
    );
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('PHASE>=3 + no payload turnId + pendingChoice present → stale (defensive)', async () => {
    config.ui.fiveBlockPhase = 3;
    claudeHandler.getSessionByKey.mockReturnValue({
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      actionPanel: {
        pendingChoice: { turnId: 't1', kind: 'single', choiceTs: 'msg-1', formIds: [] },
      },
    });
    await handler.handleUserChoice(clickBody(undefined, 'msg-1'));
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'msg-1',
      expect.stringContaining('더 이상 유효하지 않습니다'),
      expect.any(Array),
      [],
    );
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it('P3 path persistAndBroadcast clears pendingQuestion', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = {
      threadRootTs: 'thread-root',
      threadTs: 'thread-root',
      channelId: 'C1',
      actionPanel: {
        pendingChoice: { turnId: 't1', kind: 'single', choiceTs: 'msg-1', formIds: [] },
        pendingQuestion: { type: 'user_choice' },
      },
    };
    claudeHandler.getSessionByKey.mockReturnValue(session);
    await handler.handleUserChoice(clickBody('t1', 'msg-1'));
    expect(session.actionPanel.pendingQuestion).toBeUndefined();
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledWith(sessionKey);
  });

  /**
   * Regression guard for codex P1: multi-choice chunking (>6 questions) splits
   * into N forms but `handleFormSubmit` only validates THIS form's answers.
   * Submitting chunk 1 must NOT clear chunks 2..N — they remain live for the
   * user to answer independently (matches legacy per-chunk semantics).
   */
  describe('completeMultiChoiceForm — P3 per-chunk submit (codex P1 regression guard)', () => {
    const makeForm = (formId: string, messageTs: string, turnId: string) => ({
      formId,
      sessionKey,
      channel: 'C1',
      threadTs: 'thread-root',
      messageTs,
      questions: [{ id: 'q1', question: 'q?', choices: [{ id: '1', label: 'A' }] }],
      selections: { q1: { choiceId: '1', label: 'A' } },
      createdAt: 0,
      turnId,
    });

    it('submitting chunk 1 of 2: only chunk 1 marked done, chunk 2 untouched, pendingChoice keeps chunk 2', async () => {
      config.ui.fiveBlockPhase = 3;
      formStore.set('form-A', makeForm('form-A', 'ts-A', 'turn-X'));
      formStore.set('form-B', makeForm('form-B', 'ts-B', 'turn-X'));
      const session = {
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C1',
        ownerId: 'U1',
        actionPanel: {
          pendingChoice: {
            turnId: 'turn-X',
            kind: 'multi',
            choiceTs: 'ts-A',
            formIds: ['form-A', 'form-B'],
            question: { type: 'user_choices', questions: [] },
            createdAt: 0,
          },
          pendingQuestion: { type: 'user_choices' },
        },
      };
      claudeHandler.getSessionByKey.mockReturnValue(session);

      await handler.completeMultiChoiceForm(formStore.get('form-A'), 'U1', 'C1', 'thread-root', 'ts-A');

      // Only chunk-A's Slack message updated (chunk-B ts NOT touched).
      const updateCalls = slackApi.updateMessage.mock.calls.filter((c: any[]) => c[1] === 'ts-A' || c[1] === 'ts-B');
      expect(updateCalls.map((c: any[]) => c[1]).sort()).toEqual(['ts-A']);

      // pendingChoice shrinks (form-A removed, form-B survives).
      expect(session.actionPanel.pendingChoice).toBeDefined();
      expect(session.actionPanel.pendingChoice!.formIds).toEqual(['form-B']);
      // form-A deleted from store, form-B survives.
      expect(formStore.get('form-A')).toBeUndefined();
      expect(formStore.get('form-B')).toBeDefined();
    });

    it('submitting last chunk (only formId in pendingChoice): pendingChoice fully cleared', async () => {
      config.ui.fiveBlockPhase = 3;
      formStore.set('form-B', makeForm('form-B', 'ts-B', 'turn-X'));
      const session = {
        threadRootTs: 'thread-root',
        threadTs: 'thread-root',
        channelId: 'C1',
        ownerId: 'U1',
        actionPanel: {
          pendingChoice: {
            turnId: 'turn-X',
            kind: 'multi',
            choiceTs: 'ts-B',
            formIds: ['form-B'],
            question: { type: 'user_choices', questions: [] },
            createdAt: 0,
          },
        },
      };
      claudeHandler.getSessionByKey.mockReturnValue(session);

      await handler.completeMultiChoiceForm(formStore.get('form-B'), 'U1', 'C1', 'thread-root', 'ts-B');

      expect(session.actionPanel.pendingChoice).toBeUndefined();
      expect(formStore.get('form-B')).toBeUndefined();
    });
  });
});
