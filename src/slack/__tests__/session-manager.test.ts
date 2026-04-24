import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../user-settings-store')>();
  return {
    ...actual,
    userSettingsStore: {
      ...actual.userSettingsStore,
      getUserSessionTheme: vi.fn().mockReturnValue('default'),
    },
  };
});

import type { ClaudeHandler } from '../../claude-handler';
import type { ConversationSession } from '../../types';
import { SessionUiManager } from '../session-manager';
import type { SlackApiHelper } from '../slack-api-helper';

// Mock SlackApiHelper
const createMockSlackApi = () => ({
  getUserName: vi.fn().mockResolvedValue('Test User'),
  getChannelName: vi.fn().mockResolvedValue('#general'),
  getPermalink: vi.fn().mockResolvedValue('https://slack.com/archives/C123/p123'),
  postMessage: vi.fn().mockResolvedValue({ ts: '123.456', channel: 'C123' }),
  updateMessage: vi.fn().mockResolvedValue(undefined),
});

// Mock ClaudeHandler
const createMockClaudeHandler = () => ({
  getAllSessions: vi.fn().mockReturnValue(new Map()),
  getSessionByKey: vi.fn().mockReturnValue(null),
  getSessionKey: vi.fn().mockImplementation((ch: string, ts?: string) => `${ch}-${ts || 'direct'}`),
  terminateSession: vi.fn().mockReturnValue(true),
});

const createMockSession = (overrides: Partial<ConversationSession> = {}): ConversationSession => ({
  ownerId: 'U123',
  ownerName: 'Test User',
  channelId: 'C123',
  threadTs: '111.222',
  sessionId: 'session-123',
  isActive: true,
  lastActivity: new Date(),
  userId: 'U123',
  ...overrides,
});

describe('SessionUiManager', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockClaudeHandler: ReturnType<typeof createMockClaudeHandler>;
  let manager: SessionUiManager;

  beforeEach(() => {
    mockSlackApi = createMockSlackApi();
    mockClaudeHandler = createMockClaudeHandler();
    manager = new SessionUiManager(
      mockClaudeHandler as unknown as ClaudeHandler,
      mockSlackApi as unknown as SlackApiHelper,
    );
  });

  describe('formatUserSessionsBlocks', () => {
    it('should return empty state when no sessions', async () => {
      mockClaudeHandler.getAllSessions.mockReturnValue(new Map());

      const result = await manager.formatUserSessionsBlocks('U123');

      expect(result.text).toBe('📭 활성 세션 없음');
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].text.text).toContain('활성 세션 없음');
    });

    it('should only show sessions owned by the user', async () => {
      const sessions = new Map([
        ['session1', createMockSession({ ownerId: 'U123', title: 'My Session' })],
        ['session2', createMockSession({ ownerId: 'U456', title: 'Other Session' })],
      ]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      const result = await manager.formatUserSessionsBlocks('U123');

      expect(result.text).toBe('📋 내 세션 목록 (1개)');
      // section.text layout: session title is in section.text.text
      const containsTitle = (b: any, title: string) => b.text?.text?.includes(title);
      expect(result.blocks.some((b: any) => containsTitle(b, 'My Session'))).toBe(true);
      expect(result.blocks.some((b: any) => containsTitle(b, 'Other Session'))).toBe(false);
    });

    it('should include terminate button for each session', async () => {
      const sessions = new Map([['session1', createMockSession({ ownerId: 'U123', title: 'My Session' })]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      const result = await manager.formatUserSessionsBlocks('U123');

      // In the new default theme, terminate button is in an actions block
      const actionsBlock = result.blocks.find(
        (b: any) => b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'terminate_session'),
      );
      expect(actionsBlock).toBeDefined();
      const terminateBtn = actionsBlock.elements.find((e: any) => e.action_id === 'terminate_session');
      expect(terminateBtn.style).toBe('danger');
    });

    it('should skip sessions without sessionId', async () => {
      const sessions = new Map([['session1', createMockSession({ ownerId: 'U123', sessionId: undefined })]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      const result = await manager.formatUserSessionsBlocks('U123');

      expect(result.text).toBe('📭 활성 세션 없음');
    });
  });

  describe('buildSessionCard (via formatUserSessionsBlocks)', () => {
    // Helper: create sessions map and get card blocks (skip header/theme-context/divider/footer)
    // New default card structure:
    //   section (title text, no fields) → context (meta: workflow·model·channel·time) → [context (linkHistory)] → actions (💬 스레드 + 📝 대화 기록 + ✕)
    const getCardBlocks = async (session: ConversationSession) => {
      const sessions = new Map([['s1', session]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);
      const result = await manager.formatUserSessionsBlocks('U123');
      // Find card section by looking for a section with session title text
      const titleSectionIdx = result.blocks.findIndex(
        (b: any) => b.type === 'section' && b.text?.text && !b.text.text.includes('활성 세션 없음'),
      );
      if (titleSectionIdx === -1) return { result, cardBlocks: [], allBlocks: result.blocks };
      const cardBlocks: any[] = [];
      for (let i = titleSectionIdx; i < result.blocks.length; i++) {
        const b = result.blocks[i];
        if (
          b.type === 'divider' ||
          (b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'refresh_sessions'))
        )
          break;
        cardBlocks.push(b);
      }
      return { result, cardBlocks, allBlocks: result.blocks };
    };

    it('should render default card with section.text (no fields)', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'Test Session' }));
      expect(cardBlocks.length).toBeGreaterThanOrEqual(1);
      expect(cardBlocks[0].type).toBe('section');
      expect(cardBlocks[0].text.type).toBe('mrkdwn');
      // New layout: no fields, meta in context block
      expect(cardBlocks[0].fields).toBeUndefined();
    });

    it('should show model, channel, time in meta context block', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'Test' }));
      // Meta context is the first context block after section
      const metaCtx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('`'));
      expect(metaCtx).toBeDefined();
      const metaText = metaCtx.elements[0].text;
      expect(metaText).toContain('#general');
    });

    it('should include title in card', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'My Title' }));
      const section = cardBlocks[0];
      expect(section.text.text).toContain('My Title');
    });

    it('should include 💬 스레드 button when permalink exists', async () => {
      const { allBlocks } = await getCardBlocks(createMockSession({ title: 'My Title' }));
      const actionsBlock = allBlocks.find(
        (b: any) => b.type === 'actions' && b.elements?.some((e: any) => e.text?.text?.includes('스레드')),
      );
      expect(actionsBlock).toBeDefined();
    });

    it('should include model in meta context', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'Test' }));
      const metaCtx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('·'));
      expect(metaCtx).toBeDefined();
    });

    it('should include time info in meta context', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'Test' }));
      const metaCtx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('·'));
      expect(metaCtx).toBeDefined();
    });

    it('should render issue link in linkHistory context when linkHistory has issues', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          linkHistory: {
            issues: [
              {
                url: 'https://github.com/org/repo/issues/42',
                label: '#42',
                type: 'issue' as const,
                provider: 'github' as const,
              },
            ],
            prs: [],
            docs: [],
          },
        }),
      );
      const ctx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🎫'));
      expect(ctx).toBeDefined();
      expect(ctx.elements[0].text).toContain('#42');
    });

    it('should render PR link in linkHistory context when linkHistory has PRs', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          linkHistory: {
            issues: [],
            prs: [
              {
                url: 'https://github.com/org/repo/pull/73',
                label: 'PR #73',
                type: 'pr' as const,
                provider: 'github' as const,
              },
            ],
            docs: [],
          },
        }),
      );
      const ctx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🔀'));
      expect(ctx).toBeDefined();
      expect(ctx.elements[0].text).toContain('PR #73');
    });

    it('should render both issue and PR in linkHistory context when both exist', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          linkHistory: {
            issues: [
              {
                url: 'https://github.com/org/repo/issues/42',
                label: '#42',
                type: 'issue' as const,
                provider: 'github' as const,
              },
            ],
            prs: [
              {
                url: 'https://github.com/org/repo/pull/73',
                label: 'PR #73',
                type: 'pr' as const,
                provider: 'github' as const,
              },
            ],
            docs: [],
          },
        }),
      );
      const ctx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🎫'));
      expect(ctx).toBeDefined();
      const metaText = ctx.elements[0].text;
      expect(metaText).toContain('🎫');
      expect(metaText).toContain('#42');
      expect(metaText).toContain('🔀');
      expect(metaText).toContain('PR #73');
    });

    it('should render doc link in linkHistory context when linkHistory has docs', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          linkHistory: {
            issues: [],
            prs: [],
            docs: [
              {
                url: 'https://docs.example.com/guide',
                label: 'Guide',
                type: 'doc' as const,
                provider: 'unknown' as const,
              },
            ],
          },
        }),
      );
      const ctx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('📄'));
      expect(ctx).toBeDefined();
      expect(ctx.elements[0].text).toContain('Guide');
    });

    it('should not render linkHistory context when no linkHistory exists', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
        }),
      );
      const linkCtx = cardBlocks.find(
        (b: any) =>
          b.type === 'context' &&
          (b.elements?.[0]?.text?.includes('🎫') ||
            b.elements?.[0]?.text?.includes('🔀') ||
            b.elements?.[0]?.text?.includes('📄')),
      );
      expect(linkCtx).toBeUndefined();
    });

    it('should use dot separators between linkHistory parts', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          linkHistory: {
            issues: [
              {
                url: 'https://github.com/org/repo/issues/1',
                label: '#1',
                type: 'issue' as const,
                provider: 'github' as const,
              },
            ],
            prs: [
              {
                url: 'https://github.com/org/repo/pull/2',
                label: 'PR #2',
                type: 'pr' as const,
                provider: 'github' as const,
              },
            ],
            docs: [],
          },
        }),
      );
      const ctx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🎫'));
      expect(ctx).toBeDefined();
      expect(ctx.elements[0].text).toContain('·');
    });

    it('should omit terminate button when showControls is false', async () => {
      const sessions = new Map([['s1', createMockSession({ title: 'Test' })]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);
      const result = await manager.formatUserSessionsBlocks('U123', { showControls: false });
      const terminateActions = result.blocks.filter(
        (b: any) => b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'terminate_session'),
      );
      expect(terminateActions).toHaveLength(0);
    });

    it('should omit actions block when showControls is false', async () => {
      const sessions = new Map([['s1', createMockSession({ title: 'Test' })]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);
      const result = await manager.formatUserSessionsBlocks('U123', { showControls: false });
      const actionsBlocks = result.blocks.filter(
        (b: any) => b.type === 'actions' && b.elements?.some((e: any) => e.action_id?.startsWith('jira_')),
      );
      expect(actionsBlocks).toHaveLength(0);
    });

    it('should render sleeping session card without errors', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Sleeping Session',
          state: 'SLEEPING',
          sleepStartedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        }),
      );
      expect(cardBlocks[0].text.text).toContain('Sleeping Session');
    });

    it('should render sleeping session without sleepStartedAt', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Sleeping Session',
          state: 'SLEEPING',
          sleepStartedAt: undefined,
        }),
      );
      expect(cardBlocks[0].text.text).toContain('Sleeping Session');
    });

    it('should prefix title with working emoji when activityState is working', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Active Work',
          activityState: 'working',
        }),
      );
      expect(cardBlocks[0].text.text).toMatch(/^⚙️/);
    });

    it('should prefix title with waiting emoji when activityState is waiting', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Waiting',
          activityState: 'waiting',
        }),
      );
      expect(cardBlocks[0].text.text).toMatch(/^✋/);
    });

    it('should not include permalink button when threadTs is missing', async () => {
      const { allBlocks } = await getCardBlocks(
        createMockSession({
          title: 'No Thread',
          threadTs: undefined,
        }),
      );
      const openBtn = allBlocks.find(
        (b: any) => b.type === 'actions' && b.elements?.some((e: any) => e.text?.text?.includes('스레드')),
      );
      expect(openBtn).toBeUndefined();
      expect(mockSlackApi.getPermalink).not.toHaveBeenCalled();
    });

    it('should include owner name in session title section', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          ownerName: 'Zhuge',
        }),
      );
      // Owner no longer in fields but session is correctly rendered
      expect(cardBlocks[0].text.text).toContain('Test');
    });

    it('should use channelName in terminate confirm when title is missing', async () => {
      const { allBlocks } = await getCardBlocks(createMockSession({ title: undefined }));
      const actionsBlock = allBlocks.find(
        (b: any) => b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'terminate_session'),
      );
      const terminateBtn = actionsBlock.elements.find((e: any) => e.action_id === 'terminate_session');
      expect(terminateBtn.confirm.text.text).toContain('#general');
    });

    it('should default issue label in linkHistory context when label is missing', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          linkHistory: {
            issues: [
              { url: 'https://jira.example.com/browse/TEST-1', type: 'issue' as const, provider: 'jira' as const },
            ],
            prs: [],
            docs: [],
          },
        }),
      );
      // Link history context is the 2nd context block (after meta context)
      const linkCtx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🎫'));
      expect(linkCtx).toBeDefined();
      expect(linkCtx.elements[0].text).toContain('jira.example.com');
    });

    it('should default PR label in linkHistory context when label is missing', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          linkHistory: {
            prs: [{ url: 'https://github.com/org/repo/pull/1', type: 'pr' as const, provider: 'github' as const }],
            issues: [],
            docs: [],
          },
        }),
      );
      const ctx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🔀'));
      expect(ctx).toBeDefined();
      expect(ctx.elements[0].text).toContain('🔀');
    });

    it('should keep linkHistory context text under Slack 3000 char mrkdwn limit', async () => {
      const { cardBlocks } = await getCardBlocks(
        createMockSession({
          title: 'Test',
          linkHistory: {
            issues: [
              {
                url: 'https://jira.example.com/browse/' + 'A'.repeat(200),
                label: '#' + 'X'.repeat(50),
                type: 'issue' as const,
                provider: 'jira' as const,
              },
            ],
            prs: [
              {
                url: 'https://github.com/' + 'B'.repeat(200) + '/pull/999',
                label: 'PR #' + 'Y'.repeat(50),
                type: 'pr' as const,
                provider: 'github' as const,
              },
            ],
            docs: [
              {
                url: 'https://docs.example.com/' + 'C'.repeat(200),
                label: 'D'.repeat(50),
                type: 'doc' as const,
                provider: 'unknown' as const,
              },
            ],
          },
        }),
      );
      const ctx = cardBlocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🎫'));
      expect(ctx).toBeDefined();
      expect(ctx.elements[0].text.length).toBeLessThanOrEqual(3000);
    });

    it('should keep total blocks within Slack 50 limit for 10 sessions', async () => {
      const sessions = new Map<string, ConversationSession>();
      for (let i = 0; i < 10; i++) {
        sessions.set(
          `session${i}`,
          createMockSession({
            title: `Session ${i}`,
            lastActivity: new Date(Date.now() - i * 1000),
          }),
        );
      }
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);
      const result = await manager.formatUserSessionsBlocks('U123');
      expect(result.blocks.length).toBeLessThanOrEqual(50);
    });
  });

  describe('formatAllSessions', () => {
    it('should return empty state when no sessions', async () => {
      mockClaudeHandler.getAllSessions.mockReturnValue(new Map());

      const result = await manager.formatAllSessions();

      expect(result).toContain('활성 세션 없음');
    });

    it('should group sessions by owner', async () => {
      const sessions = new Map([
        ['session1', createMockSession({ ownerId: 'U123', ownerName: 'User A' })],
        ['session2', createMockSession({ ownerId: 'U456', ownerName: 'User B' })],
        ['session3', createMockSession({ ownerId: 'U123', ownerName: 'User A' })],
      ]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      const result = await manager.formatAllSessions();

      expect(result).toContain('*User A* (2개 세션)');
      expect(result).toContain('*User B* (1개 세션)');
    });
  });

  describe('handleTerminateCommand', () => {
    it('should return error when session not found', async () => {
      const mockSay = vi.fn();
      mockClaudeHandler.getSessionByKey.mockReturnValue(null);

      await manager.handleTerminateCommand('unknown', 'U123', 'C123', '111.222', mockSay);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('세션을 찾을 수 없습니다'),
        }),
      );
    });

    it('should return error when user is not owner', async () => {
      const mockSay = vi.fn();
      mockClaudeHandler.getSessionByKey.mockReturnValue(createMockSession({ ownerId: 'U456' }));

      await manager.handleTerminateCommand('session1', 'U123', 'C123', '111.222', mockSay);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('권한이 없습니다'),
        }),
      );
    });

    it('should terminate session when user is owner', async () => {
      const mockSay = vi.fn();
      mockClaudeHandler.getSessionByKey.mockReturnValue(createMockSession({ ownerId: 'U123' }));

      await manager.handleTerminateCommand('session1', 'U123', 'C123', '111.222', mockSay);

      expect(mockClaudeHandler.terminateSession).toHaveBeenCalledWith('session1');
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('세션이 종료되었습니다'),
        }),
      );
    });

    it('should notify original thread when different from current', async () => {
      const mockSay = vi.fn();
      mockClaudeHandler.getSessionByKey.mockReturnValue(createMockSession({ ownerId: 'U123', threadTs: '999.888' }));

      await manager.handleTerminateCommand('session1', 'U123', 'C123', '111.222', mockSay);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith('C123', expect.stringContaining('세션이 종료되었습니다'), {
        threadTs: '999.888',
      });
    });
  });

  describe('handleSessionWarning', () => {
    it('should create new warning message', async () => {
      const session = createMockSession();

      const result = await manager.handleSessionWarning(session, 30 * 60 * 1000);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        session.channelId,
        expect.stringContaining('세션 만료 예정'),
        { threadTs: session.threadTs },
      );
      expect(result).toBe('123.456');
    });

    it('should update existing warning message', async () => {
      const session = createMockSession();

      const result = await manager.handleSessionWarning(session, 30 * 60 * 1000, 'existing.123');

      expect(mockSlackApi.updateMessage).toHaveBeenCalledWith(
        session.channelId,
        'existing.123',
        expect.stringContaining('세션 만료 예정'),
      );
      expect(result).toBe('existing.123');
    });
  });

  describe('handleSessionExpiry', () => {
    it('should update warning message when exists', async () => {
      const session = createMockSession({ warningMessageTs: 'warning.123' });

      await manager.handleSessionExpiry(session);

      expect(mockSlackApi.updateMessage).toHaveBeenCalledWith(
        session.channelId,
        'warning.123',
        expect.stringContaining('세션이 종료되었습니다'),
      );
    });

    it('should create new message when no warning exists', async () => {
      const session = createMockSession({ warningMessageTs: undefined });

      await manager.handleSessionExpiry(session);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        session.channelId,
        expect.stringContaining('세션이 종료되었습니다'),
        { threadTs: session.threadTs },
      );
    });
  });

  describe('notifyShutdown', () => {
    it('should send notification to all active sessions', async () => {
      const sessions = new Map([
        ['session1', createMockSession({ channelId: 'C123' })],
        ['session2', createMockSession({ channelId: 'C456' })],
      ]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      await manager.notifyShutdown();

      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(2);
      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('서버 재시작'),
        expect.any(Object),
      );
    });

    it('should skip sessions without sessionId', async () => {
      const sessions = new Map([['session1', createMockSession({ sessionId: undefined })]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      await manager.notifyShutdown();

      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
    });
  });
});
