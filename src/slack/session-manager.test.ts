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
      expect(result.blocks.some((b: any) => b.text?.text?.includes('My Session'))).toBe(true);
      expect(result.blocks.some((b: any) => b.text?.text?.includes('Other Session'))).toBe(false);
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
