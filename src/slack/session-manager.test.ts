import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionUiManager } from './session-manager';
import { SlackApiHelper } from './slack-api-helper';
import { ClaudeHandler } from '../claude-handler';
import { ConversationSession } from '../types';

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
      mockSlackApi as unknown as SlackApiHelper
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
      const containsTitle = (b: any, title: string) =>
        b.text?.text?.includes(title);
      expect(result.blocks.some((b: any) => containsTitle(b, 'My Session'))).toBe(true);
      expect(result.blocks.some((b: any) => containsTitle(b, 'Other Session'))).toBe(false);
    });

    it('should include terminate button for each session', async () => {
      const sessions = new Map([
        ['session1', createMockSession({ ownerId: 'U123', title: 'My Session' })],
      ]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      const result = await manager.formatUserSessionsBlocks('U123');

      const sessionBlock = result.blocks.find((b: any) => b.accessory?.action_id === 'terminate_session');
      expect(sessionBlock).toBeDefined();
      expect(sessionBlock.accessory.style).toBe('danger');
    });

    it('should skip sessions without sessionId', async () => {
      const sessions = new Map([
        ['session1', createMockSession({ ownerId: 'U123', sessionId: undefined })],
      ]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      const result = await manager.formatUserSessionsBlocks('U123');

      expect(result.text).toBe('📭 활성 세션 없음');
    });
  });

  describe('buildSessionCard (via formatUserSessionsBlocks)', () => {
    // Helper: create sessions map and get card blocks (skip header/divider/footer)
    const getCardBlocks = async (session: ConversationSession) => {
      const sessions = new Map([['s1', session]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);
      const result = await manager.formatUserSessionsBlocks('U123');
      // Card blocks are between divider and final divider
      // Structure: header, divider, [card blocks...], divider, refresh, tip
      const cardBlocks = result.blocks.filter((b: any) =>
        b.type === 'section' && b.text?.text?.includes('*1.*') ||
        b.type === 'context' && b.elements?.[0]?.text?.includes('🤖')
      );
      return { result, cardBlocks, allBlocks: result.blocks };
    };

    // Helper: find the section block (title)
    const findSection = (blocks: any[]) =>
      blocks.find((b: any) => b.type === 'section' && b.text?.text?.includes('*1.*'));

    // Helper: find the context block (metadata)
    const findContext = (blocks: any[]) =>
      blocks.find((b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🤖'));

    it('should render no-links card as section.text + context (2 blocks)', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'Test Session' }));
      expect(cardBlocks).toHaveLength(2);
      expect(cardBlocks[0].type).toBe('section');
      expect(cardBlocks[0].text.type).toBe('mrkdwn');
      expect(cardBlocks[1].type).toBe('context');
    });

    it('should not use section.fields (regression guard)', async () => {
      const { allBlocks } = await getCardBlocks(createMockSession({ title: 'Test' }));
      const fieldsBlocks = allBlocks.filter((b: any) => b.fields);
      expect(fieldsBlocks).toHaveLength(0);
    });

    it('should include title, channel, and permalink in section.text', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'My Title' }));
      const section = cardBlocks[0];
      expect(section.text.text).toContain('My Title');
      expect(section.text.text).toContain('#general');
      expect(section.text.text).toContain('(열기)');
    });

    it('should include model in context metadata', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'Test' }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('🤖');
    });

    it('should include time and expiry in context', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({ title: 'Test' }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('🕐');
      expect(ctx.elements[0].text).toContain('⏳');
    });

    it('should render issue link in context when issue exists', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        links: {
          issue: { url: 'https://github.com/org/repo/issues/42', label: '#42', provider: 'github' },
        },
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('🎫');
      expect(ctx.elements[0].text).toContain('#42');
    });

    it('should render PR link in context when PR exists', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        links: {
          pr: { url: 'https://github.com/org/repo/pull/73', label: 'PR #73', provider: 'github' },
        },
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('🔀');
      expect(ctx.elements[0].text).toContain('PR #73');
    });

    it('should render both issue and PR in context when both exist', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        links: {
          issue: { url: 'https://github.com/org/repo/issues/42', label: '#42', provider: 'github' },
          pr: { url: 'https://github.com/org/repo/pull/73', label: 'PR #73', provider: 'github' },
        },
      }));
      const ctx = cardBlocks[1];
      const metaText = ctx.elements[0].text;
      expect(metaText).toContain('🎫');
      expect(metaText).toContain('#42');
      expect(metaText).toContain('🔀');
      expect(metaText).toContain('PR #73');
    });

    it('should render doc link in context when doc exists', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        links: {
          doc: { url: 'https://docs.example.com/guide', label: 'Guide', provider: 'other' },
        },
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('📄');
      expect(ctx.elements[0].text).toContain('Guide');
    });

    it('should default doc label to 문서 when label is missing', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        links: {
          doc: { url: 'https://docs.example.com', provider: 'other' },
        },
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('문서');
    });

    it('should use pipe separators between metadata parts', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        links: {
          issue: { url: 'https://github.com/org/repo/issues/1', label: '#1', provider: 'github' },
        },
      }));
      const ctx = cardBlocks[1];
      const pipeCount = (ctx.elements[0].text.match(/\|/g) || []).length;
      expect(pipeCount).toBeGreaterThanOrEqual(3); // model | issue | time | expiry
    });

    it('should omit terminate accessory when showControls is false', async () => {
      const sessions = new Map([['s1', createMockSession({ title: 'Test' })]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);
      const result = await manager.formatUserSessionsBlocks('U123', { showControls: false });
      const sectionBlocks = result.blocks.filter((b: any) => b.type === 'section' && b.text?.text?.includes('*1.*'));
      expect(sectionBlocks[0].accessory).toBeUndefined();
    });

    it('should omit actions block when showControls is false', async () => {
      const sessions = new Map([['s1', createMockSession({ title: 'Test' })]]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);
      const result = await manager.formatUserSessionsBlocks('U123', { showControls: false });
      const actionsBlocks = result.blocks.filter((b: any) => b.type === 'actions' && b.elements?.some((e: any) => e.action_id?.startsWith('jira_')));
      expect(actionsBlocks).toHaveLength(0);
    });

    it('should show sleeping session with sleep expiry text', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Sleeping Session',
        state: 'SLEEPING',
        sleepStartedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('💤');
    });

    it('should show ? for sleeping expiry when sleepStartedAt is missing', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Sleeping Session',
        state: 'SLEEPING',
        sleepStartedAt: undefined,
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('?');
    });

    it('should prefix title with working emoji when activityState is working', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Active Work',
        activityState: 'working',
      }));
      const section = cardBlocks[0];
      expect(section.text.text).toMatch(/^⚙️/);
    });

    it('should prefix title with waiting emoji when activityState is waiting', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Waiting',
        activityState: 'waiting',
      }));
      const section = cardBlocks[0];
      expect(section.text.text).toMatch(/^✋/);
    });

    it('should not include permalink when threadTs is missing', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'No Thread',
        threadTs: undefined,
      }));
      const section = cardBlocks[0];
      expect(section.text.text).not.toContain('(열기)');
      expect(mockSlackApi.getPermalink).not.toHaveBeenCalled();
    });

    it('should include initiator in context when currentInitiatorName is set', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        currentInitiatorName: 'Zhuge',
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('🎯 Zhuge');
    });

    it('should use channelName in terminate confirm when title is missing', async () => {
      const { allBlocks } = await getCardBlocks(createMockSession({ title: undefined }));
      const section = allBlocks.find((b: any) => b.accessory?.action_id === 'terminate_session');
      expect(section.accessory.confirm.text.text).toContain('#general');
    });

    it('should default issue label to 이슈 when label is missing', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        links: {
          issue: { url: 'https://jira.example.com/browse/TEST-1', provider: 'jira' },
        },
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('이슈');
    });

    it('should default PR label to PR when label is missing', async () => {
      const { cardBlocks } = await getCardBlocks(createMockSession({
        title: 'Test',
        links: {
          pr: { url: 'https://github.com/org/repo/pull/1', provider: 'github' },
        },
      }));
      const ctx = cardBlocks[1];
      expect(ctx.elements[0].text).toContain('🔀');
      expect(ctx.elements[0].text).toMatch(/<[^|]+\|PR>/);
    });

    it('should keep total blocks within Slack 50 limit for 10 sessions', async () => {
      const sessions = new Map<string, ConversationSession>();
      for (let i = 0; i < 10; i++) {
        sessions.set(`session${i}`, createMockSession({
          title: `Session ${i}`,
          lastActivity: new Date(Date.now() - i * 1000),
        }));
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
        })
      );
    });

    it('should return error when user is not owner', async () => {
      const mockSay = vi.fn();
      mockClaudeHandler.getSessionByKey.mockReturnValue(createMockSession({ ownerId: 'U456' }));

      await manager.handleTerminateCommand('session1', 'U123', 'C123', '111.222', mockSay);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('권한이 없습니다'),
        })
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
        })
      );
    });

    it('should notify original thread when different from current', async () => {
      const mockSay = vi.fn();
      mockClaudeHandler.getSessionByKey.mockReturnValue(
        createMockSession({ ownerId: 'U123', threadTs: '999.888' })
      );

      await manager.handleTerminateCommand('session1', 'U123', 'C123', '111.222', mockSay);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('세션이 종료되었습니다'),
        { threadTs: '999.888' }
      );
    });
  });

  describe('handleSessionWarning', () => {
    it('should create new warning message', async () => {
      const session = createMockSession();

      const result = await manager.handleSessionWarning(session, 30 * 60 * 1000);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        session.channelId,
        expect.stringContaining('세션 만료 예정'),
        { threadTs: session.threadTs }
      );
      expect(result).toBe('123.456');
    });

    it('should update existing warning message', async () => {
      const session = createMockSession();

      const result = await manager.handleSessionWarning(session, 30 * 60 * 1000, 'existing.123');

      expect(mockSlackApi.updateMessage).toHaveBeenCalledWith(
        session.channelId,
        'existing.123',
        expect.stringContaining('세션 만료 예정')
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
        expect.stringContaining('세션이 종료되었습니다')
      );
    });

    it('should create new message when no warning exists', async () => {
      const session = createMockSession({ warningMessageTs: undefined });

      await manager.handleSessionExpiry(session);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        session.channelId,
        expect.stringContaining('세션이 종료되었습니다'),
        { threadTs: session.threadTs }
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
        expect.any(Object)
      );
    });

    it('should skip sessions without sessionId', async () => {
      const sessions = new Map([
        ['session1', createMockSession({ sessionId: undefined })],
      ]);
      mockClaudeHandler.getAllSessions.mockReturnValue(sessions);

      await manager.notifyShutdown();

      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
    });
  });
});
