import { Assistant } from '@slack/bolt';
import { describe, expect, it, vi } from 'vitest';
import { SlackHandler } from './slack-handler';

describe('SlackHandler', () => {
  it('creates thread panel after session initialization', async () => {
    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const sessionResult = {
      session: { ownerId: 'U123' },
      sessionKey: 'C123:thread123',
      isNewSession: true,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
    };
    handlerAny.streamExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, messageCount: 1 }),
    };
    const create = vi.fn().mockResolvedValue(undefined);
    handlerAny.threadPanel = { create };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: 'hello',
    };

    await handler.handleMessage(event as any, say);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(sessionResult.session, sessionResult.sessionKey);
  });

  it('streams into bot-initiated thread when initializer returns migrated session', async () => {
    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const sessionResult = {
      session: {
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '222.333',
        threadModel: 'bot-initiated',
        threadRootTs: '222.333',
      },
      sessionKey: 'C123:222.333',
      isNewSession: true,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
    };
    const execute = vi.fn().mockResolvedValue({ success: true, messageCount: 1 });
    handlerAny.streamExecutor = { execute };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: 'hello',
    };

    await handler.handleMessage(event as any, say);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        threadTs: '222.333',
      }),
    );
  });

  it('clears waiting choice panel when user sends direct text input', async () => {
    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {
      setActivityStateByKey: vi.fn(),
    };
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const sessionResult = {
      session: {
        ownerId: 'U123',
        channelId: 'C123',
        actionPanel: {
          waitingForChoice: true,
          choiceBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'choice' } }],
        },
      },
      sessionKey: 'C123:thread123',
      isNewSession: false,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
    };
    handlerAny.streamExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, messageCount: 1 }),
    };

    const clearChoice = vi.fn().mockResolvedValue(undefined);
    handlerAny.threadPanel = {
      create: vi.fn().mockResolvedValue(undefined),
      clearChoice,
    };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: '직접 입력으로 답변할게요',
    };

    await handler.handleMessage(event as any, say);

    expect(clearChoice).toHaveBeenCalledTimes(1);
    expect(clearChoice).toHaveBeenCalledWith('C123:thread123');
  });

  it('passes forceWorkflow from continuation into runDispatch', async () => {
    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {
      resetSessionContext: vi.fn(),
      getSession: vi.fn().mockReturnValue({
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '111.222',
      }),
    };
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const sessionResult = {
      session: {
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '111.222',
      },
      sessionKey: 'C123:111.222',
      isNewSession: true,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
      runDispatch: vi.fn().mockResolvedValue(undefined),
    };
    handlerAny.streamExecutor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          messageCount: 1,
          continuation: {
            prompt: 'new https://github.com/acme/repo/pull/1',
            resetSession: true,
            dispatchText: 'https://github.com/acme/repo/pull/1',
            forceWorkflow: 'pr-review',
          },
        })
        .mockResolvedValueOnce({ success: true, messageCount: 1 }),
    };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: 'review this pr',
    };

    await handler.handleMessage(event as any, say);

    expect(claudeHandler.resetSessionContext).toHaveBeenCalledWith('C123', '111.222');
    expect(handlerAny.sessionInitializer.runDispatch).toHaveBeenCalledWith(
      'C123',
      '111.222',
      'https://github.com/acme/repo/pull/1',
      'pr-review',
    );
  });

  it('uses persisted sourceThread for continuation messages in work thread', async () => {
    // Bug: When user sends a follow-up message in the work thread,
    // activeThreadTs === originalThreadTs, so sourceThreadTs was set to undefined.
    // Fix: Fall back to session.sourceThread from the persisted session.
    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    // Simulate a continuation message: user posts directly in the work thread.
    // The session already has sourceThread from the initial thread migration.
    const sessionResult = {
      session: {
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '222.333',
        threadRootTs: '222.333',
        sourceThread: { channel: 'C123', threadTs: '111.000' }, // original source thread
      },
      sessionKey: 'C123:222.333',
      isNewSession: false,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
    };
    const execute = vi.fn().mockResolvedValue({ success: true, messageCount: 1 });
    handlerAny.streamExecutor = { execute };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    // User posts in the work thread (thread_ts === work thread's ts)
    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: '222.333',
      ts: '333.444',
      text: 'continue working',
    };

    await handler.handleMessage(event as any, say);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadTs: '111.000', // should fall back to session.sourceThread
        sourceChannel: 'C123',
      }),
    );
  });

  it('admin deletes bot-authored message permalink sent in DM directly', async () => {
    // Mock admin check
    const { resetAdminUsersCache } = await import('./admin-utils');
    process.env.ADMIN_USERS = 'U_ADMIN';
    resetAdminUsersCache();

    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      getMessage: vi.fn().mockResolvedValue({
        ts: '111.222',
        user: 'B999',
      }),
      getBotUserId: vi.fn().mockResolvedValue('B999'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn(),
      routeCommand: vi.fn(),
    };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U_ADMIN',
      channel: 'D123',
      ts: '555.666',
      text: 'https://workspace.slack.com/archives/C999/p111222000000',
    };

    await handler.handleMessage(event as any, say);

    expect(mockSlackApi.deleteMessage).toHaveBeenCalledWith('C999', '111222.000000');
    expect(mockSlackApi.addReaction).toHaveBeenCalledWith('D123', '555.666', 'white_check_mark');
    expect(say).not.toHaveBeenCalled();
    expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();

    // Cleanup
    delete process.env.ADMIN_USERS;
    resetAdminUsersCache();
  });

  it('non-admin sends delete approval request to admins when permalink sent in DM', async () => {
    const { resetAdminUsersCache } = await import('./admin-utils');
    process.env.ADMIN_USERS = 'U_ADMIN';
    resetAdminUsersCache();

    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      getMessage: vi.fn().mockResolvedValue({
        ts: '222333.000000',
        thread_ts: '222333.000000',
        user: 'B999',
      }),
      getBotUserId: vi.fn().mockResolvedValue('B999'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      openDmChannel: vi.fn().mockResolvedValue('D_ADMIN'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'admin_msg_123' }),
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn(),
      routeCommand: vi.fn(),
    };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U_REGULAR',
      channel: 'D123',
      ts: '555.666',
      text: 'https://workspace.slack.com/archives/C999/p222333000000',
    };

    await handler.handleMessage(event as any, say);

    // Should NOT delete directly
    expect(mockSlackApi.deleteMessage).not.toHaveBeenCalled();
    // Should send approval request to admin DM
    expect(mockSlackApi.openDmChannel).toHaveBeenCalledWith('U_ADMIN');
    expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
      'D_ADMIN',
      '봇 메시지 삭제 요청',
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({ action_id: 'dm_delete_approve' }),
              expect.objectContaining({ action_id: 'dm_delete_reject' }),
            ]),
          }),
        ]),
      }),
    );
    // Should notify the requester
    expect(say).toHaveBeenCalledWith({ text: '📨 어드민에게 삭제 요청을 보냈습니다. 승인 후 삭제됩니다.' });
    expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();

    // Cleanup
    delete process.env.ADMIN_USERS;
    resetAdminUsersCache();
  });

  it('DM plain text from non-admin is rejected via Gate A (Issue #553)', async () => {
    // Old spec §6 silent-drop → new Issue #553 UX: ephemeral guide + ❎ reaction,
    // pipeline MUST NOT be entered. (Admin plain text is covered by T1 below.)
    const { resetAdminUsersCache } = await import('./admin-utils');
    const prevAdmins = process.env.ADMIN_USERS;
    process.env.ADMIN_USERS = 'U_ADMIN';
    resetAdminUsersCache();

    try {
      const app = { client: {}, assistant: vi.fn() } as any;
      const claudeHandler = {};
      const mcpManager = {};

      const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
      const handlerAny = handler as any;

      const mockSlackApi = {
        addReaction: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
        postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph.1' }),
      };

      handlerAny.slackApi = mockSlackApi;
      handlerAny.inputProcessor = {
        processFiles: vi.fn(),
        routeCommand: vi.fn(),
      };
      handlerAny.sessionInitializer = {
        validateWorkingDirectory: vi.fn(),
        initialize: vi.fn(),
      };

      const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
      const event = {
        user: 'U_NORMAL', // not in ADMIN_USERS
        channel: 'D123',
        ts: '555.666',
        text: 'hello bot',
      };

      await handler.handleMessage(event as any, say);

      // Pipeline MUST NOT be entered.
      expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
      expect(handlerAny.sessionInitializer.initialize).not.toHaveBeenCalled();
      expect(mockSlackApi.addReaction).not.toHaveBeenCalledWith('D123', '555.666', 'eyes');
      // New rejection UX.
      expect(mockSlackApi.postEphemeral).toHaveBeenCalledWith(
        'D123',
        'U_NORMAL',
        expect.stringContaining('DM에서는 관리자만'),
        '555.666',
      );
      expect(mockSlackApi.addReaction).toHaveBeenCalledWith('D123', '555.666', 'heavy_multiplication_x');
    } finally {
      if (prevAdmins === undefined) {
        delete process.env.ADMIN_USERS;
      } else {
        process.env.ADMIN_USERS = prevAdmins;
      }
      resetAdminUsersCache();
    }
  });

  /* ============================================================
   * FIX #1 (PR #509): DM /z routing through ZRouter
   * ============================================================ */

  it('DM `/z help` routes through ZRouter with source=dm (FIX #1)', async () => {
    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const dispatch = vi.fn().mockResolvedValue({ handled: true, consumed: true });
    handlerAny.eventRouter = { getZRouter: () => ({ dispatch }) };
    handlerAny.slackApi = {
      getClient: vi.fn().mockReturnValue({
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: 'bot.1' }),
          update: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      }),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };
    handlerAny.inputProcessor = {
      processFiles: vi.fn(),
      routeCommand: vi.fn(),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn(),
      initialize: vi.fn(),
    };

    const say = vi.fn();
    const event = {
      user: 'U123',
      channel: 'D123',
      ts: '555.666',
      text: '/z help',
      team: 'T_X',
    };

    await handler.handleMessage(event as any, say);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const inv = dispatch.mock.calls[0][0];
    expect(inv.source).toBe('dm');
    expect(inv.remainder).toBe('help');
    // ZRouter handles the response — legacy pipeline MUST NOT run.
    expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
    expect(handlerAny.sessionInitializer.initialize).not.toHaveBeenCalled();
  });

  it('DM `new hello` (session-creating naked) falls through for admin (FIX #1)', async () => {
    // Issue #553: `new` is NOT in the non-admin DM allowlist (it creates a
    // session from scratch). Admin, on the other hand, may use any naked form.
    const { resetAdminUsersCache } = await import('./admin-utils');
    const prevAdmins = process.env.ADMIN_USERS;
    process.env.ADMIN_USERS = 'U_ADMIN';
    resetAdminUsersCache();

    try {
      const app = { client: {}, assistant: vi.fn() } as any;
      const claudeHandler = {};
      const mcpManager = {};

      const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
      const handlerAny = handler as any;

      const dispatch = vi.fn().mockResolvedValue({ handled: true, consumed: true });
      handlerAny.eventRouter = { getZRouter: () => ({ dispatch }) };
      handlerAny.slackApi = {
        getClient: vi.fn(),
        addReaction: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
        postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph.1' }),
      };
      handlerAny.inputProcessor = {
        processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: false }),
        routeCommand: vi.fn(),
      };
      handlerAny.sessionInitializer = {
        validateWorkingDirectory: vi.fn(),
        initialize: vi.fn(),
      };

      const say = vi.fn();
      const event = {
        user: 'U_ADMIN',
        channel: 'D123',
        ts: '555.666',
        text: 'new hello world',
      };

      await handler.handleMessage(event as any, say);

      // Naked does NOT go to ZRouter from DM — it falls through.
      expect(dispatch).not.toHaveBeenCalled();
      // Legacy pipeline was entered (processFiles called).
      expect(handlerAny.inputProcessor.processFiles).toHaveBeenCalled();
    } finally {
      if (prevAdmins === undefined) {
        delete process.env.ADMIN_USERS;
      } else {
        process.env.ADMIN_USERS = prevAdmins;
      }
      resetAdminUsersCache();
    }
  });

  it('DM `persona set linus` (legacy naked, not whitelisted) is rejected for non-admin with ❎ + guide (#553)', async () => {
    // Pre-#553: silent drop. Post-#553: Gate A ephemeral + ❎ reaction because
    // `persona` is not in the non-admin allowlist. Admin users are unaffected
    // here; this case is specifically non-admin.
    const { resetAdminUsersCache } = await import('./admin-utils');
    const prevAdmins = process.env.ADMIN_USERS;
    process.env.ADMIN_USERS = 'U_ADMIN';
    resetAdminUsersCache();

    try {
      const app = { client: {}, assistant: vi.fn() } as any;
      const claudeHandler = {};
      const mcpManager = {};

      const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
      const handlerAny = handler as any;

      const dispatch = vi.fn().mockResolvedValue({ handled: true, consumed: true });
      handlerAny.eventRouter = { getZRouter: () => ({ dispatch }) };
      handlerAny.slackApi = {
        getClient: vi.fn(),
        addReaction: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
        postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph.1' }),
      };
      handlerAny.inputProcessor = {
        processFiles: vi.fn(),
        routeCommand: vi.fn(),
      };
      handlerAny.sessionInitializer = {
        validateWorkingDirectory: vi.fn(),
        initialize: vi.fn(),
      };

      const say = vi.fn();
      const event = {
        user: 'U_NORMAL',
        channel: 'D123',
        ts: '555.666',
        text: 'persona set linus',
      };

      await handler.handleMessage(event as any, say);

      // Router was never reached, pipeline was never entered.
      expect(dispatch).not.toHaveBeenCalled();
      expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
      expect(handlerAny.sessionInitializer.initialize).not.toHaveBeenCalled();
      // But now the user gets a clear response instead of silence.
      expect(handlerAny.slackApi.postEphemeral).toHaveBeenCalledWith(
        'D123',
        'U_NORMAL',
        expect.stringContaining('DM에서는 관리자만'),
        '555.666',
      );
      expect(handlerAny.slackApi.addReaction).toHaveBeenCalledWith('D123', '555.666', 'heavy_multiplication_x');
    } finally {
      if (prevAdmins === undefined) {
        delete process.env.ADMIN_USERS;
      } else {
        process.env.ADMIN_USERS = prevAdmins;
      }
      resetAdminUsersCache();
    }
  });

  it('DM `/z new <prompt>` with continueWithPrompt substitutes text and continues pipeline for admin (codex P1 followup)', async () => {
    // When ZRouter captures a follow-up prompt (e.g. new-handler returns
    // continueWithPrompt), the DM entry MUST continue the normal pipeline with
    // that prompt instead of silently no-opping.
    //
    // Issue #553: `new` is not in the non-admin SAFE_Z_TOPICS allowlist, so
    // this flow is admin-only. Use U_ADMIN to preserve the original intent
    // (that the substituted text reaches the pipeline).
    const { resetAdminUsersCache } = await import('./admin-utils');
    const prevAdmins = process.env.ADMIN_USERS;
    process.env.ADMIN_USERS = 'U_ADMIN';
    resetAdminUsersCache();

    try {
      const app = { client: {}, assistant: vi.fn() } as any;
      const claudeHandler = {};
      const mcpManager = {};

      const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
      const handlerAny = handler as any;

      const dispatch = vi.fn().mockResolvedValue({
        handled: true,
        continueWithPrompt: 'write a failing test',
      });
      handlerAny.eventRouter = { getZRouter: () => ({ dispatch }) };
      handlerAny.slackApi = {
        getClient: vi.fn().mockReturnValue({
          chat: {
            postMessage: vi.fn().mockResolvedValue({ ts: 'bot.1' }),
            update: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(undefined),
          },
        }),
        addReaction: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
        postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph.1' }),
      };
      // shouldContinue:false lets us stop after processFiles so we don't need
      // to stub the whole pipeline — the key assertion is that the
      // *substituted* text reaches the pipeline.
      handlerAny.inputProcessor = {
        processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: false }),
        routeCommand: vi.fn(),
      };
      handlerAny.sessionInitializer = {
        validateWorkingDirectory: vi.fn(),
        initialize: vi.fn(),
      };

      const say = vi.fn();
      const event = {
        user: 'U_ADMIN',
        channel: 'D123',
        ts: '555.666',
        text: '/z new write a failing test',
      };

      await handler.handleMessage(event as any, say);

      // ZRouter saw the invocation.
      expect(dispatch).toHaveBeenCalledTimes(1);
      // Pipeline was entered with the substituted prompt.
      expect(handlerAny.inputProcessor.processFiles).toHaveBeenCalledTimes(1);
      const forwardedEvent = handlerAny.inputProcessor.processFiles.mock.calls[0][0];
      expect(forwardedEvent.text).toBe('write a failing test');
    } finally {
      if (prevAdmins === undefined) {
        delete process.env.ADMIN_USERS;
      } else {
        process.env.ADMIN_USERS = prevAdmins;
      }
      resetAdminUsersCache();
    }
  });

  /* ============================================================
   * Issue #553 — DM always responds (admin/non-admin matrix)
   * ============================================================ */

  describe('Issue #553 — DM always responds', () => {
    // Shared fixture for the admin/non-admin gate tests.
    // Each test swaps `event.user` between U_ADMIN and U_NORMAL.
    const withAdmins = async <T>(fn: () => Promise<T>): Promise<T> => {
      const { resetAdminUsersCache } = await import('./admin-utils');
      const prevAdmins = process.env.ADMIN_USERS;
      process.env.ADMIN_USERS = 'U_ADMIN';
      resetAdminUsersCache();
      try {
        return await fn();
      } finally {
        if (prevAdmins === undefined) {
          delete process.env.ADMIN_USERS;
        } else {
          process.env.ADMIN_USERS = prevAdmins;
        }
        resetAdminUsersCache();
      }
    };

    // Build a SlackHandler stubbed for the Gate A / Gate B paths.
    // `dispatchResult` drives `routeDmViaZRouter` when text starts with `/z`.
    const buildHandler = (
      opts: { dispatchResult?: any; routeCommandResult?: { handled: boolean; continueWithPrompt?: string } } = {},
    ) => {
      const app = { client: {}, assistant: vi.fn() } as any;
      const claudeHandler = {};
      const mcpManager = {};
      const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
      const handlerAny = handler as any;

      const dispatch = vi.fn().mockResolvedValue(opts.dispatchResult ?? { handled: true, consumed: true });
      handlerAny.eventRouter = { getZRouter: () => ({ dispatch }) };

      const slackApi = {
        getClient: vi.fn().mockReturnValue({
          chat: {
            postMessage: vi.fn().mockResolvedValue({ ts: 'bot.1' }),
            update: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(undefined),
          },
        }),
        addReaction: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
        postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph.1' }),
      };
      handlerAny.slackApi = slackApi;

      handlerAny.inputProcessor = {
        processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: false }),
        routeCommand: vi
          .fn()
          .mockResolvedValue(opts.routeCommandResult ?? { handled: false, continueWithPrompt: undefined }),
      };
      handlerAny.sessionInitializer = {
        validateWorkingDirectory: vi.fn(),
        initialize: vi.fn(),
      };

      return { handler, handlerAny, dispatch, slackApi };
    };

    // T1 — Admin plain text DM enters the normal pipeline unmodified.
    it('T1: admin DM plain text enters pipeline with original text (no promotion)', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny } = buildHandler();
        const event = { user: 'U_ADMIN', channel: 'D123', ts: '1.1', text: 'hello' };

        await handler.handleMessage(event as any, vi.fn());

        expect(handlerAny.inputProcessor.processFiles).toHaveBeenCalledTimes(1);
        const forwardedEvent = handlerAny.inputProcessor.processFiles.mock.calls[0][0];
        // Text must reach the pipeline unchanged (no `new hello` rewrite).
        expect(forwardedEvent.text).toBe('hello');
      });
    });

    // T2 — Non-admin plain text DM is rejected by Gate A.
    it('T2: non-admin DM plain text is rejected by Gate A (ephemeral + ❎)', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, slackApi } = buildHandler();
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '2.2', text: 'hello' };

        await handler.handleMessage(event as any, vi.fn());

        // Gate A fires before processFiles — pipeline untouched.
        expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
        expect(handlerAny.sessionInitializer.initialize).not.toHaveBeenCalled();
        expect(slackApi.postEphemeral).toHaveBeenCalledWith(
          'D123',
          'U_NORMAL',
          expect.stringContaining('DM에서는 관리자만'),
          '2.2',
        );
        expect(slackApi.addReaction).toHaveBeenCalledWith('D123', '2.2', 'heavy_multiplication_x');
      });
    });

    // T3 — Non-admin `/z session` passes Gate A (sessions is in SAFE_Z_TOPICS).
    it('T3: non-admin DM `/z sessions` reaches ZRouter (safe topic)', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, dispatch, slackApi } = buildHandler();
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '3.3', text: '/z sessions' };

        await handler.handleMessage(event as any, vi.fn());

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(slackApi.postEphemeral).not.toHaveBeenCalled();
        expect(slackApi.addReaction).not.toHaveBeenCalledWith('D123', '3.3', 'heavy_multiplication_x');
      });
    });

    // T4 — Non-admin naked `sessions` enters the pipeline (legacy route).
    it('T4: non-admin DM `sessions` (naked whitelist) enters pipeline', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, dispatch, slackApi } = buildHandler();
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '4.4', text: 'sessions' };

        await handler.handleMessage(event as any, vi.fn());

        // Naked `sessions` is NOT `/z`, so ZRouter stays silent.
        expect(dispatch).not.toHaveBeenCalled();
        // Pipeline was entered — processFiles called.
        expect(handlerAny.inputProcessor.processFiles).toHaveBeenCalledTimes(1);
        expect(slackApi.postEphemeral).not.toHaveBeenCalled();
      });
    });

    // T5 — Non-admin `/z new foo` is rejected (new NOT in SAFE_Z_TOPICS).
    it('T5: non-admin DM `/z new foo` rejected (session-creating topic)', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, dispatch, slackApi } = buildHandler();
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '5.5', text: '/z new foo' };

        await handler.handleMessage(event as any, vi.fn());

        // ZRouter never reached — Gate A terminated.
        expect(dispatch).not.toHaveBeenCalled();
        expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
        expect(slackApi.addReaction).toHaveBeenCalledWith('D123', '5.5', 'heavy_multiplication_x');
      });
    });

    // T6 — Non-admin `/z thinking on` is rejected (thinking is not a
    // registered /z topic).
    it('T6: non-admin DM `/z thinking on` rejected (unregistered topic)', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, dispatch, slackApi } = buildHandler();
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '6.6', text: '/z thinking on' };

        await handler.handleMessage(event as any, vi.fn());

        expect(dispatch).not.toHaveBeenCalled();
        expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
        expect(slackApi.postEphemeral).toHaveBeenCalled();
        expect(slackApi.addReaction).toHaveBeenCalledWith('D123', '6.6', 'heavy_multiplication_x');
      });
    });

    // T7 — Admin `/z new foo` reaches ZRouter.
    it('T7: admin DM `/z new foo` reaches ZRouter', async () => {
      await withAdmins(async () => {
        const { handler, dispatch, slackApi } = buildHandler({
          dispatchResult: { handled: true, consumed: true },
        });
        const event = { user: 'U_ADMIN', channel: 'D123', ts: '7.7', text: '/z new foo' };

        await handler.handleMessage(event as any, vi.fn());

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(slackApi.addReaction).not.toHaveBeenCalledWith('D123', '7.7', 'heavy_multiplication_x');
      });
    });

    // T8 — Non-admin `%model sonnet` passes Gate A and reaches the pipeline.
    it('T8: non-admin DM `%model sonnet` passes Gate A', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, dispatch, slackApi } = buildHandler();
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '8.8', text: '%model sonnet' };

        await handler.handleMessage(event as any, vi.fn());

        expect(dispatch).not.toHaveBeenCalled();
        expect(handlerAny.inputProcessor.processFiles).toHaveBeenCalledTimes(1);
        expect(slackApi.postEphemeral).not.toHaveBeenCalled();
      });
    });

    // T9 — Non-admin bare `/z` reaches ZRouter (help card path).
    it('T9: non-admin DM bare `/z` reaches ZRouter (help card)', async () => {
      await withAdmins(async () => {
        const { handler, dispatch } = buildHandler();
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '9.9', text: '/z' };

        await handler.handleMessage(event as any, vi.fn());

        expect(dispatch).toHaveBeenCalledTimes(1);
      });
    });

    // T10 — Non-admin DM with file upload + plain text caption is rejected
    // BEFORE processFiles (no 📎 messages leak).
    it('T10: non-admin DM file upload + plain caption rejected before processFiles', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, slackApi } = buildHandler();
        const event = {
          user: 'U_NORMAL',
          channel: 'D123',
          ts: '10.10',
          text: 'analyze this',
          files: [{ id: 'F1', name: 'report.pdf' }],
        };

        await handler.handleMessage(event as any, vi.fn());

        expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
        expect(slackApi.postEphemeral).toHaveBeenCalled();
        expect(slackApi.addReaction).toHaveBeenCalledWith('D123', '10.10', 'heavy_multiplication_x');
      });
    });

    // T11 — Admin DM cleanup permalink still routes to handleDmCleanupRequest
    // and short-circuits before Gate A.
    it('T11: admin DM permalink triggers cleanup and short-circuits Gate A', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, slackApi } = buildHandler();
        const getMessage = vi.fn().mockResolvedValue({ ts: '111.222', user: 'B999' });
        const getBotUserId = vi.fn().mockResolvedValue('B999');
        const deleteMessage = vi.fn().mockResolvedValue(undefined);
        Object.assign(slackApi, { getMessage, getBotUserId, deleteMessage });

        const event = {
          user: 'U_ADMIN',
          channel: 'D123',
          ts: '11.11',
          text: 'https://workspace.slack.com/archives/C999/p111222000000',
        };

        await handler.handleMessage(event as any, vi.fn());

        expect(deleteMessage).toHaveBeenCalled();
        expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
      });
    });

    // T12 — Non-admin DM bare `help` passes Gate A and reaches the pipeline
    // (HelpHandler runs inside CommandRouter).
    it('T12: non-admin DM `help` passes Gate A', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, slackApi } = buildHandler({
          routeCommandResult: { handled: true, continueWithPrompt: undefined },
        });
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '12.12', text: 'help' };

        await handler.handleMessage(event as any, vi.fn());

        // Gate A passed — pipeline entered.
        expect(handlerAny.inputProcessor.processFiles).toHaveBeenCalledTimes(1);
        // No rejection UX.
        expect(slackApi.postEphemeral).not.toHaveBeenCalled();
        expect(slackApi.addReaction).not.toHaveBeenCalledWith('D123', '12.12', 'heavy_multiplication_x');
      });
    });

    // T17 — codex P1 R2b followup: admin DM plain text reaches `sessionInitializer.initialize`.
    // Previously every Issue #553 test stopped at `processFiles({ shouldContinue: false })`,
    // so the acceptance criterion "admin DM 평문 → 인라인 세션 + 프롬프트 응답" was asserted
    // at Gate A only. This test forces the full happy path so a Gate B / session-init
    // regression cannot silently pass.
    it('T17: admin DM plain text reaches sessionInitializer.initialize (happy path)', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny } = buildHandler();
        handlerAny.inputProcessor.processFiles = vi.fn().mockResolvedValue({ files: [], shouldContinue: true });
        handlerAny.inputProcessor.routeCommand = vi
          .fn()
          .mockResolvedValue({ handled: false, continueWithPrompt: undefined });
        handlerAny.sessionInitializer.validateWorkingDirectory = vi.fn().mockResolvedValue({ valid: true });
        // Short-circuit with halted:true so the test proves `initialize` was
        // reached without having to stub the downstream session/streaming setup.
        // Asserting that `initialize` was called is the T17 goal — anything
        // deeper (channel routing, activity state) is covered by channel tests.
        handlerAny.sessionInitializer.initialize = vi.fn().mockResolvedValue({
          halted: true,
        });

        const event = { user: 'U_ADMIN', channel: 'D123', ts: '17.17', text: 'build me a widget' };
        await handler.handleMessage(event as any, vi.fn());

        expect(handlerAny.sessionInitializer.validateWorkingDirectory).toHaveBeenCalledTimes(1);
        expect(handlerAny.sessionInitializer.initialize).toHaveBeenCalledTimes(1);
        // Gate B must NOT fire for admins.
        expect(handlerAny.slackApi.postEphemeral).not.toHaveBeenCalled();
        expect(handlerAny.slackApi.addReaction).not.toHaveBeenCalledWith('D123', '17.17', 'heavy_multiplication_x');
      });
    });

    // T18 — codex P1 R2a followup: Gate B backstop fires when non-admin input passes
    // Gate A but no command handler claims it (routeCommand returns handled:false).
    // Verifies (a) eyes removal, (b) heavy_multiplication_x attached, (c) pipeline
    // NEVER reaches sessionInitializer.
    it('T18: non-admin DM that survives Gate A but hits routeCommand={handled:false} is rejected by Gate B', async () => {
      await withAdmins(async () => {
        const { handler, handlerAny, slackApi } = buildHandler({
          // routeCommand returns handled:false — the exact condition Gate B targets.
          routeCommandResult: { handled: false, continueWithPrompt: undefined },
        });
        handlerAny.inputProcessor.processFiles = vi.fn().mockResolvedValue({ files: [], shouldContinue: true });

        // `%model` passes Gate A (SAFE). Here we simulate routeCommand failing to
        // claim it — Gate B must catch and reject instead of falling through to
        // session init.
        const event = { user: 'U_NORMAL', channel: 'D123', ts: '18.18', text: '%model' };
        await handler.handleMessage(event as any, vi.fn());

        // Gate B side effects.
        expect(slackApi.removeReaction).toHaveBeenCalledWith('D123', '18.18', 'eyes');
        expect(slackApi.postEphemeral).toHaveBeenCalledTimes(1);
        expect(slackApi.addReaction).toHaveBeenCalledWith('D123', '18.18', 'heavy_multiplication_x');
        // Pipeline did NOT advance to session init.
        expect(handlerAny.sessionInitializer.initialize).not.toHaveBeenCalled();
      });
    });

    // T19 — gemini P0 R4 followup: sendDmNonAdminRejection must NOT re-introduce a
    // silent drop when the Slack `addReaction` call throws. Before the fix,
    // `postEphemeral` was wrapped in try/catch but `addReaction` was not, so a
    // transient Slack failure would bubble up as an unhandled rejection from
    // `handleMessage` — precisely the Issue #553 silent-drop symptom.
    it('T19: sendDmNonAdminRejection swallows addReaction failures (no unhandled rejection)', async () => {
      await withAdmins(async () => {
        const { handler, slackApi } = buildHandler();
        // Simulate a flaky Slack reaction endpoint.
        slackApi.addReaction = vi.fn().mockRejectedValue(new Error('slack 500'));
        slackApi.postEphemeral = vi.fn().mockResolvedValue({ ts: 'eph.1' });

        const event = { user: 'U_NORMAL', channel: 'D123', ts: '19.19', text: 'plain prompt' };

        // Must NOT throw. If this assertion fails we are silently dropping DMs again.
        await expect(handler.handleMessage(event as any, vi.fn())).resolves.not.toThrow();

        // Ephemeral guide was still delivered (the user sees some feedback).
        expect(slackApi.postEphemeral).toHaveBeenCalledTimes(1);
      });
    });
  });

  /* ============================================================
   * #666 P4 Part 1/2 — Bolt Assistant container registration
   * ============================================================ */
  describe('SlackHandler — Bolt Assistant container registration (#666)', () => {
    it('registers the Bolt Assistant container exactly once at construction time', () => {
      const app = { client: {}, assistant: vi.fn() } as any;
      const claudeHandler = {};
      const mcpManager = {};

      new SlackHandler(app as any, claudeHandler as any, mcpManager as any);

      expect(app.assistant).toHaveBeenCalledTimes(1);
      const registered = app.assistant.mock.calls[0][0];
      expect(registered).toBeInstanceOf(Assistant);
    });
  });
});
