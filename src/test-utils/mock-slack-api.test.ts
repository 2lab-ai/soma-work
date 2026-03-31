import { describe, expect, it, vi } from 'vitest';
import { createMockSlackApi } from './mock-slack-api';

describe('createMockSlackApi', () => {
  it('should return an object with all SlackApiHelper methods as mocks', () => {
    const mock = createMockSlackApi();

    // Core messaging
    expect(mock.postMessage).toBeDefined();
    expect(mock.updateMessage).toBeDefined();
    expect(mock.deleteMessage).toBeDefined();
    expect(mock.postEphemeral).toBeDefined();
    expect(mock.postSystemMessage).toBeDefined();

    // Reactions
    expect(mock.addReaction).toBeDefined();
    expect(mock.removeReaction).toBeDefined();

    // Queries
    expect(mock.getMessage).toBeDefined();
    expect(mock.getUserName).toBeDefined();
    expect(mock.getChannelName).toBeDefined();
    expect(mock.getPermalink).toBeDefined();
    expect(mock.getBotUserId).toBeDefined();
    expect(mock.getChannelInfo).toBeDefined();

    // Assistant
    expect(mock.setAssistantStatus).toBeDefined();
    expect(mock.setAssistantTitle).toBeDefined();

    // Modal
    expect(mock.openModal).toBeDefined();

    // Thread
    expect(mock.deleteThreadBotMessages).toBeDefined();
  });

  it('should have default return values for common methods', async () => {
    const mock = createMockSlackApi();

    const postResult = await mock.postMessage('C123', 'hello', {});
    expect(postResult).toEqual({ ts: '123.456', channel: 'C123' });

    const botId = await mock.getBotUserId();
    expect(botId).toBe('B999');

    const reaction = await mock.addReaction('C123', '111.222', 'thumbsup');
    expect(reaction).toBe(true);
  });

  it('should allow overriding specific methods', () => {
    const mock = createMockSlackApi({
      postMessage: vi.fn().mockResolvedValue({ ts: 'custom.ts', channel: 'CXXX' }),
      getBotUserId: vi.fn().mockResolvedValue('BCUSTOM'),
    });

    expect(mock.postMessage).not.toEqual(createMockSlackApi().postMessage);
    expect(mock.updateMessage).toBeDefined(); // Non-overridden still present
  });

  it('should create independent instances each call', () => {
    const mock1 = createMockSlackApi();
    const mock2 = createMockSlackApi();

    mock1.postMessage('C1', 'msg1', {});
    expect(mock2.postMessage).not.toHaveBeenCalled();
  });
});
