import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventRouter, EventRouterDeps } from './event-router';
import { SlackApiHelper } from './slack-api-helper';
import { SessionUiManager } from './session-manager';
import { ActionHandlers, MessageHandler } from './action-handlers';
import { ClaudeHandler } from '../claude-handler';
import { ConversationSession } from '../types';

// Mock dependencies
const createMockSlackApi = () => ({
  getBotUserId: vi.fn().mockResolvedValue('B123'),
  getChannelInfo: vi.fn().mockResolvedValue({ name: 'general' }),
  addReaction: vi.fn().mockResolvedValue(true),
});

const createMockClaudeHandler = () => ({
  getSession: vi.fn().mockReturnValue(null),
  setExpiryCallbacks: vi.fn(),
  cleanupInactiveSessions: vi.fn().mockResolvedValue(undefined),
});

const createMockSessionManager = () => ({
  handleSessionWarning: vi.fn().mockResolvedValue('123.456'),
  handleSessionExpiry: vi.fn().mockResolvedValue(undefined),
});

const createMockActionHandlers = () => ({
  registerHandlers: vi.fn(),
});

const createMockApp = () => ({
  message: vi.fn(),
  event: vi.fn(),
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

describe('EventRouter', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockClaudeHandler: ReturnType<typeof createMockClaudeHandler>;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockActionHandlers: ReturnType<typeof createMockActionHandlers>;
  let mockApp: ReturnType<typeof createMockApp>;
  let mockMessageHandler: MessageHandler;
  let deps: EventRouterDeps;
  let router: EventRouter;

  beforeEach(() => {
    mockSlackApi = createMockSlackApi();
    mockClaudeHandler = createMockClaudeHandler();
    mockSessionManager = createMockSessionManager();
    mockActionHandlers = createMockActionHandlers();
    mockApp = createMockApp();
    mockMessageHandler = vi.fn().mockResolvedValue(undefined) as unknown as MessageHandler;

    deps = {
      slackApi: mockSlackApi as unknown as SlackApiHelper,
      claudeHandler: mockClaudeHandler as unknown as ClaudeHandler,
      sessionManager: mockSessionManager as unknown as SessionUiManager,
      actionHandlers: mockActionHandlers as unknown as ActionHandlers,
    };

    router = new EventRouter(mockApp as any, deps, mockMessageHandler);
  });

  afterEach(() => {
    // Clean up interval to prevent open handles in tests
    router.cleanup();
  });

  describe('setup', () => {
    it('should register all event handlers', () => {
      router.setup();

      expect(mockApp.message).toHaveBeenCalled();
      expect(mockApp.event).toHaveBeenCalledWith('app_mention', expect.any(Function));
      expect(mockApp.event).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockApp.event).toHaveBeenCalledWith('member_joined_channel', expect.any(Function));
      expect(mockActionHandlers.registerHandlers).toHaveBeenCalledWith(mockApp);
      expect(mockClaudeHandler.setExpiryCallbacks).toHaveBeenCalled();
    });
  });

  describe('DM message handler', () => {
    it('should handle DM messages', async () => {
      router.setup();

      // Get the message handler
      const messageHandler = mockApp.message.mock.calls[0][0];

      const mockMessage = {
        user: 'U123',
        channel: 'D456', // DM channel starts with D
        ts: '123.456',
        text: 'Hello',
      };
      const mockSay = vi.fn();

      await messageHandler({ message: mockMessage, say: mockSay });

      expect(mockMessageHandler).toHaveBeenCalledWith(mockMessage, mockSay);
    });

    it('should ignore non-DM messages', async () => {
      router.setup();

      const messageHandler = mockApp.message.mock.calls[0][0];

      const mockMessage = {
        user: 'U123',
        channel: 'C456', // Channel, not DM
        ts: '123.456',
        text: 'Hello',
      };
      const mockSay = vi.fn();

      await messageHandler({ message: mockMessage, say: mockSay });

      expect(mockMessageHandler).not.toHaveBeenCalled();
    });
  });

  describe('app_mention handler', () => {
    it('should strip mention and handle message', async () => {
      router.setup();

      // Find app_mention handler
      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'app_mention'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> Hello bot',
        thread_ts: undefined,
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Hello bot' }),
        mockSay
      );
    });
  });

  describe('thread message handler', () => {
    it('should handle thread messages when session exists', async () => {
      mockClaudeHandler.getSession.mockReturnValue(createMockSession());
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        thread_ts: '111.222',
        ts: '333.444',
        text: 'Reply in thread',
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).toHaveBeenCalled();
    });

    it('should ignore thread messages without session', async () => {
      mockClaudeHandler.getSession.mockReturnValue(null);
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        thread_ts: '111.222',
        ts: '333.444',
        text: 'Reply in thread',
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).not.toHaveBeenCalled();
    });

    it('should skip messages with bot mention', async () => {
      mockClaudeHandler.getSession.mockReturnValue(createMockSession());
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        thread_ts: '111.222',
        ts: '333.444',
        text: '<@B123> mention in thread', // Contains bot mention
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Should not be handled here (app_mention handles it)
      expect(mockMessageHandler).not.toHaveBeenCalled();
    });
  });

  describe('member_joined_channel handler', () => {
    it('should send welcome message when bot joins', async () => {
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'member_joined_channel'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'B123', // Bot user ID
        channel: 'C456',
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Claude Code'),
        })
      );
    });

    it('should not send message when other user joins', async () => {
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'member_joined_channel'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U999', // Different user
        channel: 'C456',
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockSay).not.toHaveBeenCalled();
    });
  });

  describe('session expiry callbacks', () => {
    it('should register expiry callbacks', () => {
      router.setup();

      expect(mockClaudeHandler.setExpiryCallbacks).toHaveBeenCalledWith({
        onWarning: expect.any(Function),
        onExpiry: expect.any(Function),
      });
    });

    it('should call session manager on warning', async () => {
      router.setup();

      const callbacks = mockClaudeHandler.setExpiryCallbacks.mock.calls[0][0];
      const session = createMockSession();

      await callbacks.onWarning(session, 30 * 60 * 1000, undefined);

      expect(mockSessionManager.handleSessionWarning).toHaveBeenCalledWith(
        session,
        30 * 60 * 1000,
        undefined
      );
    });

    it('should call session manager on expiry', async () => {
      router.setup();

      const callbacks = mockClaudeHandler.setExpiryCallbacks.mock.calls[0][0];
      const session = createMockSession();

      await callbacks.onExpiry(session);

      expect(mockSessionManager.handleSessionExpiry).toHaveBeenCalledWith(session);
    });
  });

  describe('cleanup', () => {
    it('should clear session cleanup interval', () => {
      router.setup();

      // cleanup is called, should not throw
      expect(() => router.cleanup()).not.toThrow();
    });

    it('should be safe to call cleanup multiple times', () => {
      router.setup();

      router.cleanup();
      router.cleanup();

      // Should not throw
    });

    it('should be safe to call cleanup without setup', () => {
      // Never called setup
      expect(() => router.cleanup()).not.toThrow();
    });
  });
});
