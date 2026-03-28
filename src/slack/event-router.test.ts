import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventRouter, EventRouterDeps } from './event-router';
import { SlackApiHelper } from './slack-api-helper';
import { SessionUiManager } from './session-manager';
import { ActionHandlers, MessageHandler } from './action-handlers';
import { ClaudeHandler } from '../claude-handler';
import { ConversationSession } from '../types';

// Mock channel registry
vi.mock('../channel-registry', () => ({
  registerChannel: vi.fn().mockResolvedValue(null),
  unregisterChannel: vi.fn(),
}));

// Mock dependencies
const createMockSlackApi = () => ({
  getBotUserId: vi.fn().mockResolvedValue('B123'),
  getChannelInfo: vi.fn().mockResolvedValue({ name: 'general' }),
  getClient: vi.fn().mockReturnValue({}),
  addReaction: vi.fn().mockResolvedValue(true),
});

const createMockClaudeHandler = () => ({
  getSession: vi.fn().mockReturnValue(null),
  setExpiryCallbacks: vi.fn(),
  cleanupInactiveSessions: vi.fn().mockResolvedValue(undefined),
});

const createMockSessionManager = () => ({
  handleSessionWarning: vi.fn().mockResolvedValue('123.456'),
  handleSessionSleep: vi.fn().mockResolvedValue(undefined),
  handleSessionExpiry: vi.fn().mockResolvedValue(undefined),
});

const createMockActionHandlers = () => ({
  registerHandlers: vi.fn(),
});

const createMockApp = () => ({
  message: vi.fn(),
  event: vi.fn(),
  command: vi.fn(),
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
    it('should strip bot mention and handle message', async () => {
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

    it('should preserve other user mentions and only strip bot mention — Issue #141', async () => {
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'app_mention'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> review <@U999> PR please',
        thread_ts: undefined,
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Should preserve <@U999> and only strip bot mention <@B123>
      expect(mockMessageHandler).toHaveBeenCalledTimes(1);
      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'review <@U999> PR please' }),
        mockSay
      );
    });

    it('should handle multiple bot mentions with other user mentions — Issue #141', async () => {
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'app_mention'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> compare <@U111> and <@U222> code <@B123>',
        thread_ts: undefined,
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Both <@B123> removed, both <@U111> and <@U222> preserved
      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'compare <@U111> and <@U222> code' }),
        mockSay
      );
    });

    it('should not mutate original event text — Issue #141', async () => {
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'app_mention'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> review <@U999> code',
        thread_ts: undefined,
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Original event text should not be mutated
      expect(mockEvent.text).toBe('<@B123> review <@U999> code');
    });

    it('should preserve all mentions when getBotUserId fails — Issue #141', async () => {
      mockSlackApi.getBotUserId.mockRejectedValueOnce(new Error('API error'));
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'app_mention'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> review <@U999> code',
        thread_ts: undefined,
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // When botId unavailable, preserve all mentions (don't strip anything)
      expect(mockMessageHandler).toHaveBeenCalledTimes(1);
      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: '<@B123> review <@U999> code' }),
        mockSay
      );
    });

    it('should handle text with no mentions at all — Issue #141', async () => {
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'app_mention'
      );
      const handler = eventCall![1];

      // Edge case: app_mention event with no mention markers in text (unlikely but defensive)
      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: 'hello world',
        thread_ts: undefined,
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).toHaveBeenCalledTimes(1);
      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'hello world' }),
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
        onSleep: expect.any(Function),
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

  describe('file upload handler — Issue #127', () => {
    it('should process files with bot mention on first message (no session)', async () => {
      mockClaudeHandler.getSession.mockReturnValue(null);
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> analyze this file',
        subtype: 'file_share',
        files: [{ id: 'F1', name: 'test.png', mimetype: 'image/png' }],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Should call messageHandler exactly once with mention stripped and files intact
      expect(mockMessageHandler).toHaveBeenCalledTimes(1);
      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'analyze this file',
          files: expect.arrayContaining([expect.objectContaining({ id: 'F1' })]),
        }),
        mockSay
      );
      // Should NOT add no_entry emoji
      expect(mockSlackApi.addReaction).not.toHaveBeenCalledWith('C456', '123.456', 'no_entry');
      // Should NOT mutate original event text
      expect(mockEvent.text).toBe('<@B123> analyze this file');
    });

    it('should add no_entry for file upload without mention and no session', async () => {
      mockClaudeHandler.getSession.mockReturnValue(null);
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: 'some file',
        subtype: 'file_share',
        files: [{ id: 'F1', name: 'test.png', mimetype: 'image/png' }],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Should NOT call messageHandler
      expect(mockMessageHandler).not.toHaveBeenCalled();
      // Should add no_entry emoji
      expect(mockSlackApi.addReaction).toHaveBeenCalledWith('C456', '123.456', 'no_entry');
    });

    it('should process files in existing session thread', async () => {
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
        text: 'another file',
        subtype: 'file_share',
        files: [{ id: 'F2', name: 'data.csv', mimetype: 'text/csv' }],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).toHaveBeenCalled();
    });

    it('should always process file uploads in DM', async () => {
      mockClaudeHandler.getSession.mockReturnValue(null);
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'D456', // DM channel
        ts: '123.456',
        text: 'file in dm',
        subtype: 'file_share',
        files: [{ id: 'F3', name: 'doc.pdf', mimetype: 'application/pdf' }],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).toHaveBeenCalled();
    });

    it('should process bot-mention-only + file with no extra text', async () => {
      mockClaudeHandler.getSession.mockReturnValue(null);
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123>',
        subtype: 'file_share',
        files: [{ id: 'F1', name: 'screenshot.png', mimetype: 'image/png' }],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Should still call messageHandler even with empty text after mention strip
      expect(mockMessageHandler).toHaveBeenCalledTimes(1);
      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '',
          files: expect.arrayContaining([expect.objectContaining({ id: 'F1' })]),
        }),
        mockSay
      );
    });

    it('should preserve other user mentions and only strip bot mention', async () => {
      mockClaudeHandler.getSession.mockReturnValue(null);
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> compare with <@U999> file',
        subtype: 'file_share',
        files: [{ id: 'F1', name: 'test.png', mimetype: 'image/png' }],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Should preserve other user mentions
      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'compare with <@U999> file',
        }),
        mockSay
      );
    });

    it('should add no_entry when file has other user mention but not bot', async () => {
      mockClaudeHandler.getSession.mockReturnValue(null);
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@U999> check this',
        subtype: 'file_share',
        files: [{ id: 'F1', name: 'test.png', mimetype: 'image/png' }],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).not.toHaveBeenCalled();
      expect(mockSlackApi.addReaction).toHaveBeenCalledWith('C456', '123.456', 'no_entry');
    });

    it('should handle multiple files with bot mention', async () => {
      mockClaudeHandler.getSession.mockReturnValue(null);
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'message'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> review these files',
        subtype: 'file_share',
        files: [
          { id: 'F1', name: 'test.png', mimetype: 'image/png' },
          { id: 'F2', name: 'data.csv', mimetype: 'text/csv' },
          { id: 'F3', name: 'code.ts', mimetype: 'text/typescript' },
        ],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).toHaveBeenCalledTimes(1);
      const passedEvent = (mockMessageHandler as any).mock.calls[0][0];
      expect(passedEvent.files).toHaveLength(3);
    });
  });

  describe('app_mention dedup — Issue #127', () => {
    it('should skip app_mention when event has files (file_share handles it)', async () => {
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'app_mention'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> check this file',
        files: [{ id: 'F1', name: 'test.png' }],
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      // Should NOT call messageHandler (file_share handler will process this)
      expect(mockMessageHandler).not.toHaveBeenCalled();
    });

    it('should process app_mention normally when no files', async () => {
      router.setup();

      const eventCall = mockApp.event.mock.calls.find(
        (call) => call[0] === 'app_mention'
      );
      const handler = eventCall![1];

      const mockEvent = {
        user: 'U123',
        channel: 'C456',
        ts: '123.456',
        text: '<@B123> hello',
        thread_ts: undefined,
      };
      const mockSay = vi.fn();

      await handler({ event: mockEvent, say: mockSay });

      expect(mockMessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'hello' }),
        mockSay
      );
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
