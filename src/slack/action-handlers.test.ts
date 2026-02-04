import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionHandlers, ActionHandlerContext, MessageHandler } from './action-handlers';
import { SlackApiHelper } from './slack-api-helper';
import { SessionUiManager } from './session-manager';
import { ClaudeHandler } from '../claude-handler';
import { ConversationSession } from '../types';

// Mock dependencies
const createMockSlackApi = () => ({
  getUserName: vi.fn().mockResolvedValue('Test User'),
  getChannelName: vi.fn().mockResolvedValue('#general'),
  postMessage: vi.fn().mockResolvedValue({ ts: '123.456', channel: 'C123' }),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  postEphemeral: vi.fn().mockResolvedValue(undefined),
});

const createMockClaudeHandler = () => ({
  getSessionByKey: vi.fn().mockReturnValue(null),
  terminateSession: vi.fn().mockReturnValue(true),
});

const createMockSessionManager = () => ({
  formatUserSessionsBlocks: vi.fn().mockResolvedValue({ text: 'Sessions', blocks: [] }),
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

describe('ActionHandlers', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockClaudeHandler: ReturnType<typeof createMockClaudeHandler>;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockMessageHandler: MessageHandler;
  let handlers: ActionHandlers;
  let ctx: ActionHandlerContext;

  beforeEach(() => {
    mockSlackApi = createMockSlackApi();
    mockClaudeHandler = createMockClaudeHandler();
    mockSessionManager = createMockSessionManager();
    mockMessageHandler = vi.fn().mockResolvedValue(undefined) as unknown as MessageHandler;

    ctx = {
      slackApi: mockSlackApi as unknown as SlackApiHelper,
      claudeHandler: mockClaudeHandler as unknown as ClaudeHandler,
      sessionManager: mockSessionManager as unknown as SessionUiManager,
      messageHandler: mockMessageHandler,
    };

    handlers = new ActionHandlers(ctx);
  });

  describe('registerHandlers', () => {
    it('should register all action handlers', () => {
      const mockApp = {
        action: vi.fn(),
        view: vi.fn(),
      };

      handlers.registerHandlers(mockApp as any);

      expect(mockApp.action).toHaveBeenCalledWith('approve_tool', expect.any(Function));
      expect(mockApp.action).toHaveBeenCalledWith('deny_tool', expect.any(Function));
      expect(mockApp.action).toHaveBeenCalledWith('terminate_session', expect.any(Function));
      expect(mockApp.action).toHaveBeenCalledWith(/^user_choice_/, expect.any(Function));
      expect(mockApp.action).toHaveBeenCalledWith(/^multi_choice_/, expect.any(Function));
      expect(mockApp.action).toHaveBeenCalledWith(/^panel_/, expect.any(Function));
      expect(mockApp.action).toHaveBeenCalledWith('custom_input_single', expect.any(Function));
      expect(mockApp.action).toHaveBeenCalledWith(/^custom_input_multi_/, expect.any(Function));
      expect(mockApp.view).toHaveBeenCalledWith('custom_input_submit', expect.any(Function));
    });
  });

  describe('pending form management', () => {
    const formData = {
      formId: 'form1',
      sessionKey: 'session1',
      channel: 'C123',
      threadTs: '111.222',
      messageTs: '333.444',
      questions: [{ id: 'q1', question: 'Q1?', choices: [] }],
      selections: {},
      createdAt: Date.now(),
    };

    it('should store and retrieve pending form', () => {
      handlers.setPendingForm('form1', formData);
      expect(handlers.getPendingForm('form1')).toEqual(formData);
    });

    it('should return undefined for unknown form', () => {
      expect(handlers.getPendingForm('unknown')).toBeUndefined();
    });

    it('should delete pending form', () => {
      handlers.setPendingForm('form1', formData);
      handlers.deletePendingForm('form1');
      expect(handlers.getPendingForm('form1')).toBeUndefined();
    });
  });

  // Note: Testing the actual action handler methods requires invoking them
  // through the registered handlers, which is complex to mock.
  // Here we test the public interface and form management.
  // Integration tests would cover the full flow.

  describe('integration scenarios', () => {
    it('should handle terminate session flow', async () => {
      const mockApp = {
        action: vi.fn(),
        view: vi.fn(),
      };

      handlers.registerHandlers(mockApp as any);

      // Find the terminate_session handler
      const terminateCall = mockApp.action.mock.calls.find(
        (call) => call[0] === 'terminate_session'
      );
      expect(terminateCall).toBeDefined();

      const handler = terminateCall![1];

      // Mock the handler context
      const mockAck = vi.fn();
      const mockRespond = vi.fn();
      const mockBody = {
        actions: [{ value: 'session1' }],
        user: { id: 'U123' },
        channel: { id: 'C123' },
      };

      mockClaudeHandler.getSessionByKey.mockReturnValue(createMockSession({ ownerId: 'U123' }));

      await handler({ ack: mockAck, body: mockBody, respond: mockRespond });

      expect(mockAck).toHaveBeenCalled();
      expect(mockClaudeHandler.terminateSession).toHaveBeenCalledWith('session1');
    });

    it('should reject terminate from non-owner', async () => {
      const mockApp = {
        action: vi.fn(),
        view: vi.fn(),
      };

      handlers.registerHandlers(mockApp as any);

      const terminateCall = mockApp.action.mock.calls.find(
        (call) => call[0] === 'terminate_session'
      );
      const handler = terminateCall![1];

      const mockAck = vi.fn();
      const mockRespond = vi.fn();
      const mockBody = {
        actions: [{ value: 'session1' }],
        user: { id: 'U999' }, // Different user
        channel: { id: 'C123' },
      };

      mockClaudeHandler.getSessionByKey.mockReturnValue(createMockSession({ ownerId: 'U123' }));

      await handler({ ack: mockAck, body: mockBody, respond: mockRespond });

      expect(mockAck).toHaveBeenCalled();
      expect(mockClaudeHandler.terminateSession).not.toHaveBeenCalled();
      expect(mockRespond).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('권한이 없습니다'),
        })
      );
    });
  });
});
