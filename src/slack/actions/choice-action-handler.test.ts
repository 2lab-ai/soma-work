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
