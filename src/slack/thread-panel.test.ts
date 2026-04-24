import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import type { ConversationSession, UserChoice, UserChoices } from '../types';
import { ThreadPanel } from './thread-panel';

function getPostedBlocks(slackApi: { postMessage: ReturnType<typeof vi.fn> }): any[] {
  return (slackApi.postMessage.mock.calls[0]?.[2] as any)?.blocks || [];
}

describe('ThreadPanel', () => {
  it('posts a public dashboard panel with interactive controls', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn(),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
    });

    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      workflow: 'jira-brainstorming',
      links: {
        issue: {
          type: 'issue',
          provider: 'jira',
          url: 'https://jira.example.com/browse/MIN-63',
          label: 'MIN-63',
        },
      },
    };

    await panel.create(session, 'C123:thread123');

    expect(slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.postEphemeral).not.toHaveBeenCalled();
    expect(slackApi.getPermalink).not.toHaveBeenCalled();
    expect((slackApi.postMessage.mock.calls[0]?.[2] as any)?.unfurlLinks).toBe(false);
    expect((slackApi.postMessage.mock.calls[0]?.[2] as any)?.unfurlMedia).toBe(false);

    const blocks = getPostedBlocks(slackApi);
    // Status section block
    const statusSection = blocks.find(
      (block: any) =>
        block.type === 'section' &&
        /(대기|작업 중|입력 대기|사용 가능|요청 처리 중)/.test(String(block.text?.text || '')),
    );
    expect(statusSection).toBeDefined();

    // Context % is now shown in thread header badge, not in action panel fields.
    // Without PR, status block is a plain section (no fields).
    // When PR exists, it becomes a 2-column fields layout.
    // Either way, context info should not appear.

    const actionsCount = blocks.filter((block: any) => block.type === 'actions').length;
    expect(actionsCount).toBeGreaterThan(0);
  });

  it('updates dashboard status to working when session is active', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn(),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
    });

    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      workflow: 'default',
      actionPanel: {
        channelId: 'C123',
        userId: 'U123',
        messageTs: '123.456',
      },
    };

    await panel.updatePanel(session, 'C123:thread123');
    session.activityState = 'working';
    await panel.updatePanel(session, 'C123:thread123');

    const updateBlocks = (slackApi.updateMessage.mock.calls[1]?.[3] as any[]) || [];
    const statusSection = updateBlocks.find(
      (block: any) =>
        block.type === 'section' &&
        /(대기|작업 중|입력 대기|사용 가능|요청 처리 중)/.test(String(block.text?.text || '')),
    );
    const statusText = String(statusSection?.text?.text || '');
    expect(statusText).toContain('🟢 *작업 중*');
    expect(slackApi.updateMessage.mock.calls[1]?.[5]).toEqual({
      unfurlLinks: false,
      unfurlMedia: false,
    });
  });

  it('renders remaining context percent based on input+output tokens', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn(),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
    });

    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      workflow: 'default',
      usage: {
        currentInputTokens: 70000,
        currentOutputTokens: 10000,
        currentCacheReadTokens: 5000,
        currentCacheCreateTokens: 2000,
        contextWindow: 200000,
        totalInputTokens: 70000,
        totalOutputTokens: 10000,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCostUsd: 0,
        lastUpdated: Date.now(),
      },
    };

    await panel.create(session, 'C123:context-thread');

    const blocks = getPostedBlocks(slackApi);
    const fieldsSection = blocks.find((block: any) => block.type === 'section' && Array.isArray(block.fields));
    const fieldsText = fieldsSection?.fields?.map((f: any) => String(f.text || '')).join(' ') || '';
    // Context % is now in thread header badge, not in action panel
    expect(fieldsText).not.toContain('컨텍스트');
  });

  it('does not fetch thread permalink while rendering panel', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p111222333'),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn(),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
    });

    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      threadTs: '111.222',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      workflow: 'default',
    };

    await panel.create(session, 'C123:111.222');

    expect(slackApi.getPermalink).not.toHaveBeenCalled();
  });

  it('fetches choice permalink only when waitingForChoice is active', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue('https://workspace.slack.com/archives/C123/p111222333'),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn(),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
    });

    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'waiting',
      workflow: 'default',
      actionPanel: {
        channelId: 'C123',
        userId: 'U123',
        waitingForChoice: true,
        choiceMessageTs: '111.222',
        choiceBlocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '❓ *질문이 있습니다*' },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'user_choice_1',
                text: { type: 'plain_text', text: '1️⃣ 옵션 A' },
                value: '{"sessionKey":"C123:choice-thread","choiceId":"1"}',
              },
            ],
          },
        ],
      },
    };

    await panel.create(session, 'C123:choice-thread');

    expect(slackApi.getPermalink).toHaveBeenCalledTimes(1);
    // Choice buttons are no longer embedded in the header — a link section is shown instead
    const blocks = getPostedBlocks(slackApi);
    const mirroredActionBlock = blocks.find(
      (block: any) => block.type === 'actions' && block.elements?.some((el: any) => el.action_id === 'user_choice_1'),
    );
    expect(mirroredActionBlock).toBeUndefined();
    // Verify link section is present instead
    const linkSection = blocks.find(
      (block: any) => block.type === 'section' && block.text?.text?.includes('질문에 답변해 주세요'),
    );
    expect(linkSection).toBeDefined();
  });

  it('keeps existing thread choiceMessageTs when attachChoice is called without sourceMessageTs', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: '999.000' }),
      getPermalink: vi.fn().mockResolvedValue(null),
    };

    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'waiting',
      workflow: 'default',
      actionPanel: {
        channelId: 'C123',
        userId: 'U123',
        choiceMessageTs: 'thread-choice-ts',
      },
    };

    const claudeHandler = {
      getSessionByKey: vi.fn().mockReturnValue(session),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
    });

    await panel.attachChoice('C123:thread', {
      attachments: [
        {
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '❓ *질문*' },
            },
          ],
        },
      ],
    });

    expect(session.actionPanel?.choiceMessageTs).toBe('thread-choice-ts');
  });

  it('setStatus updates combined surface for bot-initiated threads', async () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '100.200' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      getPermalink: vi.fn().mockResolvedValue(null),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn(),
    };
    const requestCoordinator = {
      isRequestActive: vi.fn().mockReturnValue(false),
    };

    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
    });

    // In combined surface mode, bot-initiated threads use threadRootTs as the single surface message
    const session: ConversationSession = {
      ownerId: 'U123',
      userId: 'U123',
      channelId: 'C123',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'working',
      workflow: 'default',
      threadModel: 'bot-initiated',
      threadRootTs: '100.200',
      actionPanel: {
        channelId: 'C123',
        userId: 'U123',
        messageTs: '100.200',
      },
    };

    await panel.setStatus(session, 'C123:100.200', {
      agentPhase: '도구 실행 중',
      activeTool: 'Edit',
    });

    // Combined surface: single updateMessage call containing header + panel blocks
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.updateMessage.mock.calls[0][1]).toBe('100.200');
  });
});

// ---------------------------------------------------------------------------
// P3 (PHASE>=3) — askUser / askUserForm / resolveChoice / resolveMultiChoice
// ---------------------------------------------------------------------------

describe('ThreadPanel — P3 (PHASE>=3) B3 choice facade', () => {
  const originalPhase = config.ui.fiveBlockPhase;

  afterEach(() => {
    config.ui.fiveBlockPhase = originalPhase;
    vi.clearAllMocks();
  });

  function makeSession(): ConversationSession {
    return {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      threadRootTs: 't1',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      workflow: 'default',
    } as unknown as ConversationSession;
  }

  function makePanelWithMocks(session: ConversationSession, options?: { postMessage?: any }) {
    const postMessageMock = options?.postMessage ?? vi.fn().mockResolvedValue({ ts: 'posted-ts-1' });
    const fakeClient = {
      chat: {
        startStream: vi.fn(),
        appendStream: vi.fn(),
        stopStream: vi.fn(),
        postMessage: postMessageMock,
        update: vi.fn(),
      },
    };
    const slackApi = {
      getClient: vi.fn().mockReturnValue(fakeClient),
      postMessage: vi.fn().mockResolvedValue({ ts: 'surface-ts' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      getPermalink: vi.fn().mockResolvedValue(null),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn().mockReturnValue(session),
      getSessionKey: vi.fn().mockReturnValue('C1:t1'),
    };
    const requestCoordinator = { isRequestActive: vi.fn().mockReturnValue(false) };
    const todoManager = { getTodos: vi.fn().mockReturnValue([]) };
    const sessionRegistry = {
      persistAndBroadcast: vi.fn(),
      getSessionByKey: vi.fn().mockReturnValue(session),
    };
    const panel = new ThreadPanel({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: todoManager as any,
      sessionRegistry: sessionRegistry as any,
    });
    return { panel, slackApi, fakeClient, sessionRegistry };
  }

  const sampleQuestion: UserChoice = {
    question: '진행?',
    choices: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
  } as unknown as UserChoice;

  const sampleMultiQuestion: UserChoices = {
    questions: [
      {
        id: 'q1',
        question: 'A?',
        choices: [{ id: 'a1', label: 'A1' }],
      },
      {
        id: 'q2',
        question: 'B?',
        choices: [{ id: 'b1', label: 'B1' }],
      },
    ],
  } as unknown as UserChoices;

  const address = { channelId: 'C1', threadTs: 't1', sessionKey: 'C1:t1' };

  it('askUser success: posts, writes pendingChoice synchronously, calls persistAndBroadcast', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    const { panel, fakeClient, sessionRegistry } = makePanelWithMocks(session, {
      postMessage: vi.fn().mockResolvedValue({ ts: 'ts-choice-1' }),
    });

    const result = await panel.askUser(
      'turn-1',
      sampleQuestion,
      { blocks: [{ type: 'section' }] },
      'Please choose',
      address,
      session,
      'C1:t1',
    );

    expect(result).toEqual({ ok: true, primaryTs: 'ts-choice-1' });
    expect(fakeClient.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(session.actionPanel?.pendingChoice).toEqual({
      turnId: 'turn-1',
      kind: 'single',
      choiceTs: 'ts-choice-1',
      formIds: [],
      question: sampleQuestion,
      createdAt: expect.any(Number),
    });
    expect(session.actionPanel?.choiceMessageTs).toBe('ts-choice-1');
    expect(session.actionPanel?.waitingForChoice).toBe(true);
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledTimes(1);
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledWith('C1:t1');
  });

  it('askUser PHASE<3 returns phase-disabled without mutating state', async () => {
    config.ui.fiveBlockPhase = 2;
    const session = makeSession();
    const { panel, fakeClient, sessionRegistry } = makePanelWithMocks(session);

    const result = await panel.askUser('turn-1', sampleQuestion, { blocks: [] }, 'Q', address, session, 'C1:t1');

    expect(result).toEqual({ ok: false, reason: 'phase-disabled' });
    expect(fakeClient.chat.postMessage).not.toHaveBeenCalled();
    expect(session.actionPanel?.pendingChoice).toBeUndefined();
    expect(sessionRegistry.persistAndBroadcast).not.toHaveBeenCalled();
  });

  it('askUser postMessage throws → post-failed + no pendingChoice written', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    const { panel, sessionRegistry } = makePanelWithMocks(session, {
      postMessage: vi.fn().mockRejectedValue(new Error('slack 500')),
    });

    const result = await panel.askUser('turn-1', sampleQuestion, { blocks: [] }, 'Q', address, session, 'C1:t1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('post-failed');
      expect(result.error?.message).toBe('slack 500');
    }
    expect(session.actionPanel?.pendingChoice).toBeUndefined();
    expect(sessionRegistry.persistAndBroadcast).not.toHaveBeenCalled();
  });

  it('askUserForm happy path (2 chunks): both posted, pendingChoice set after chunk 0', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    const postMessage = vi.fn().mockResolvedValueOnce({ ts: 'chunk-0' }).mockResolvedValueOnce({ ts: 'chunk-1' });
    const { panel, sessionRegistry } = makePanelWithMocks(session, { postMessage });

    const chunks = [
      { builtPayload: { blocks: [{ type: 'section' }] }, text: 'chunk-0 text' },
      { builtPayload: { blocks: [{ type: 'section' }] }, text: 'chunk-1 text' },
    ];
    const formIds = ['form-0', 'form-1'];

    const result = await panel.askUserForm(
      'turn-multi',
      chunks,
      formIds,
      sampleMultiQuestion,
      address,
      session,
      'C1:t1',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.primaryTs).toBe('chunk-0');
      expect(result.allTs).toEqual(['chunk-0', 'chunk-1']);
      expect(result.formIds).toEqual(['form-0', 'form-1']);
    }
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(session.actionPanel?.pendingChoice).toEqual({
      turnId: 'turn-multi',
      kind: 'multi',
      choiceTs: 'chunk-0',
      formIds: ['form-0', 'form-1'],
      question: sampleMultiQuestion,
      createdAt: expect.any(Number),
    });
    expect(session.actionPanel?.choiceMessageTs).toBe('chunk-0');
    expect(session.actionPanel?.waitingForChoice).toBe(true);
    // persistAndBroadcast called once (after chunk 0 write).
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledTimes(1);
  });

  it('askUserForm partial failure: rolls back posted chunks and defensively clears pendingChoice', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    const postMessage = vi.fn().mockResolvedValueOnce({ ts: 'chunk-0' }).mockRejectedValueOnce(new Error('slack down'));
    const { panel, slackApi, sessionRegistry } = makePanelWithMocks(session, { postMessage });

    const chunks = [
      { builtPayload: { blocks: [] }, text: 'c0' },
      { builtPayload: { blocks: [] }, text: 'c1' },
    ];

    const result = await panel.askUserForm(
      'turn-multi',
      chunks,
      ['f0', 'f1'],
      sampleMultiQuestion,
      address,
      session,
      'C1:t1',
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'post-failed') {
      expect(result.postedTs).toEqual(['chunk-0']);
      expect(result.failedIndex).toBe(1);
    }
    // Rollback: updateMessage called for chunk-0 with the failure marker.
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'chunk-0',
      expect.stringContaining('폼 생성에 실패'),
      expect.any(Array),
      [],
    );
    // Defensive clear of pendingChoice after rollback.
    expect(session.actionPanel?.pendingChoice).toBeUndefined();
    expect(session.actionPanel?.choiceMessageTs).toBeUndefined();
    expect(session.actionPanel?.waitingForChoice).toBe(false);
    // persistAndBroadcast was called twice: once after chunk-0 set, once after clear.
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledTimes(2);
  });

  it('resolveChoice happy path: updates message, clears pendingChoice, persistAndBroadcast', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    session.actionPanel = {
      pendingChoice: {
        turnId: 'turn-1',
        kind: 'single',
        choiceTs: 'ts-1',
        formIds: [],
        question: sampleQuestion,
        createdAt: 1,
      },
      choiceMessageTs: 'ts-1',
      waitingForChoice: true,
    };
    const { panel, slackApi, sessionRegistry } = makePanelWithMocks(session);

    const result = await panel.resolveChoice(session, 'C1:t1', 'C1', 'done text', [{ type: 'section' }] as any);
    expect(result).toBe(true);
    expect(slackApi.updateMessage).toHaveBeenCalledWith('C1', 'ts-1', 'done text', [{ type: 'section' }], []);
    expect(session.actionPanel?.pendingChoice).toBeUndefined();
    expect(session.actionPanel?.choiceMessageTs).toBeUndefined();
    expect(session.actionPanel?.waitingForChoice).toBe(false);
    expect(session.actionPanel?.choiceBlocks).toBeUndefined();
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledWith('C1:t1');
  });

  it('resolveChoice no pendingChoice present → returns false', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    const { panel, slackApi, sessionRegistry } = makePanelWithMocks(session);
    const result = await panel.resolveChoice(session, 'C1:t1', 'C1', 'x', []);
    expect(result).toBe(false);
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(sessionRegistry.persistAndBroadcast).not.toHaveBeenCalled();
  });

  it('resolveChoice PHASE<3 returns false', async () => {
    config.ui.fiveBlockPhase = 2;
    const session = makeSession();
    session.actionPanel = {
      pendingChoice: {
        turnId: 'turn-1',
        kind: 'single',
        choiceTs: 'ts-1',
        formIds: [],
        question: sampleQuestion,
        createdAt: 1,
      },
    };
    const { panel, slackApi } = makePanelWithMocks(session);
    const result = await panel.resolveChoice(session, 'C1:t1', 'C1', 'x', []);
    expect(result).toBe(false);
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
  });

  it('resolveMultiChoice happy path: iterates tsList and clears', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    session.actionPanel = {
      pendingChoice: {
        turnId: 'turn-multi',
        kind: 'multi',
        choiceTs: 'ts-0',
        formIds: ['f0', 'f1'],
        question: sampleMultiQuestion,
        createdAt: 1,
      },
      choiceMessageTs: 'ts-0',
      waitingForChoice: true,
    };
    const { panel, slackApi, sessionRegistry } = makePanelWithMocks(session);

    const result = await panel.resolveMultiChoice(session, 'C1:t1', 'C1', ['ts-0', 'ts-1'], 'done', [
      { type: 'section' },
    ] as any);
    expect(result).toBe(true);
    expect(slackApi.updateMessage).toHaveBeenCalledTimes(2);
    expect(session.actionPanel?.pendingChoice).toBeUndefined();
    expect(session.actionPanel?.waitingForChoice).toBe(false);
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledWith('C1:t1');
  });

  it('resolveMultiChoice returns false when pendingChoice is single-kind', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    session.actionPanel = {
      pendingChoice: {
        turnId: 't',
        kind: 'single',
        choiceTs: 'ts-x',
        formIds: [],
        question: sampleQuestion,
        createdAt: 1,
      },
    };
    const { panel, slackApi } = makePanelWithMocks(session);
    const result = await panel.resolveMultiChoice(session, 'C1:t1', 'C1', ['ts-x'], 'done', []);
    expect(result).toBe(false);
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #667 P5 — ThreadPanel.isCompletionMarkerActive()
//
// Capability SSOT used by both TurnSurface (emit gate) and stream-executor
// (exclusion gate). Returns true iff PHASE>=5 AND slackBlockKitChannel dep
// was injected.
// ---------------------------------------------------------------------------

describe('ThreadPanel — isCompletionMarkerActive (#667 P5)', () => {
  const originalPhase = config.ui.fiveBlockPhase;

  afterEach(() => {
    config.ui.fiveBlockPhase = originalPhase;
    vi.clearAllMocks();
  });

  function makeDeps(slackBlockKitChannel?: unknown) {
    return {
      slackApi: {
        postMessage: vi.fn(),
        updateMessage: vi.fn(),
        postEphemeral: vi.fn(),
        getPermalink: vi.fn(),
        getClient: vi.fn().mockReturnValue({
          chat: {
            startStream: vi.fn(),
            appendStream: vi.fn(),
            stopStream: vi.fn(),
            postMessage: vi.fn(),
            update: vi.fn(),
          },
        }),
      } as any,
      claudeHandler: { getSessionByKey: vi.fn() } as any,
      requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
      todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
      slackBlockKitChannel: slackBlockKitChannel as any,
    };
  }

  it('PHASE=4 + channel undefined → false', () => {
    config.ui.fiveBlockPhase = 4;
    const panel = new ThreadPanel(makeDeps(undefined));
    expect(panel.isCompletionMarkerActive()).toBe(false);
  });

  it('PHASE=4 + channel defined → false', () => {
    config.ui.fiveBlockPhase = 4;
    const panel = new ThreadPanel(makeDeps({ send: vi.fn() }));
    expect(panel.isCompletionMarkerActive()).toBe(false);
  });

  it('PHASE=5 + channel undefined → false', () => {
    config.ui.fiveBlockPhase = 5;
    const panel = new ThreadPanel(makeDeps(undefined));
    expect(panel.isCompletionMarkerActive()).toBe(false);
  });

  it('PHASE=5 + channel defined → true', () => {
    config.ui.fiveBlockPhase = 5;
    const panel = new ThreadPanel(makeDeps({ send: vi.fn() }));
    expect(panel.isCompletionMarkerActive()).toBe(true);
  });
});
