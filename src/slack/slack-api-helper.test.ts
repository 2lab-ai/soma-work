import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackApiHelper } from './slack-api-helper';

// Mock the App
const createMockApp = () => ({
  client: {
    users: {
      info: vi.fn(),
    },
    conversations: {
      info: vi.fn(),
    },
    chat: {
      getPermalink: vi.fn(),
      postMessage: vi.fn(),
      update: vi.fn(),
      postEphemeral: vi.fn(),
    },
    reactions: {
      add: vi.fn(),
      remove: vi.fn(),
    },
    auth: {
      test: vi.fn(),
    },
    views: {
      open: vi.fn(),
    },
  },
});

describe('SlackApiHelper', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let helper: SlackApiHelper;

  beforeEach(() => {
    mockApp = createMockApp();
    helper = new SlackApiHelper(mockApp as any);
  });

  describe('getUserName', () => {
    it('should return real_name when available', async () => {
      mockApp.client.users.info.mockResolvedValue({
        user: { real_name: 'John Doe', name: 'johndoe' },
      });

      const result = await helper.getUserName('U123');
      expect(result).toBe('John Doe');
      expect(mockApp.client.users.info).toHaveBeenCalledWith({ user: 'U123' });
    });

    it('should fallback to name when real_name is not available', async () => {
      mockApp.client.users.info.mockResolvedValue({
        user: { name: 'johndoe' },
      });

      const result = await helper.getUserName('U123');
      expect(result).toBe('johndoe');
    });

    it('should return userId on error', async () => {
      mockApp.client.users.info.mockRejectedValue(new Error('API error'));

      const result = await helper.getUserName('U123');
      expect(result).toBe('U123');
    });
  });

  describe('getChannelName', () => {
    it('should return "DM" for DM channels', async () => {
      const result = await helper.getChannelName('D123ABC');
      expect(result).toBe('DM');
      expect(mockApp.client.conversations.info).not.toHaveBeenCalled();
    });

    it('should return channel name with # prefix', async () => {
      mockApp.client.conversations.info.mockResolvedValue({
        channel: { name: 'general' },
      });

      const result = await helper.getChannelName('C123');
      expect(result).toBe('#general');
    });

    it('should return channelId on error', async () => {
      mockApp.client.conversations.info.mockRejectedValue(new Error('API error'));

      const result = await helper.getChannelName('C123');
      expect(result).toBe('C123');
    });
  });

  describe('getPermalink', () => {
    it('should return permalink when successful', async () => {
      mockApp.client.chat.getPermalink.mockResolvedValue({
        permalink: 'https://slack.com/archives/C123/p123',
      });

      const result = await helper.getPermalink('C123', '123.456');
      expect(result).toBe('https://slack.com/archives/C123/p123');
    });

    it('should return null on error', async () => {
      mockApp.client.chat.getPermalink.mockRejectedValue(new Error('API error'));

      const result = await helper.getPermalink('C123', '123.456');
      expect(result).toBeNull();
    });
  });

  describe('getBotUserId', () => {
    it('should return bot user ID', async () => {
      mockApp.client.auth.test.mockResolvedValue({ user_id: 'B123' });

      const result = await helper.getBotUserId();
      expect(result).toBe('B123');
    });

    it('should cache bot user ID', async () => {
      mockApp.client.auth.test.mockResolvedValue({ user_id: 'B123' });

      await helper.getBotUserId();
      await helper.getBotUserId();

      expect(mockApp.client.auth.test).toHaveBeenCalledTimes(1);
    });

    it('should return empty string on error', async () => {
      mockApp.client.auth.test.mockRejectedValue(new Error('API error'));

      const result = await helper.getBotUserId();
      expect(result).toBe('');
    });
  });

  describe('postMessage', () => {
    it('should post message and return ts and channel', async () => {
      mockApp.client.chat.postMessage.mockResolvedValue({
        ts: '123.456',
        channel: 'C123',
      });

      const result = await helper.postMessage('C123', 'Hello');
      expect(result).toEqual({ ts: '123.456', channel: 'C123' });
    });

    it('should include options when provided', async () => {
      mockApp.client.chat.postMessage.mockResolvedValue({
        ts: '123.456',
        channel: 'C123',
      });

      await helper.postMessage('C123', 'Hello', {
        threadTs: '111.222',
        blocks: [{ type: 'section' }],
      });

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: 'Hello',
        thread_ts: '111.222',
        blocks: [{ type: 'section' }],
        attachments: undefined,
      });
    });

    it('should throw on error', async () => {
      mockApp.client.chat.postMessage.mockRejectedValue(new Error('API error'));

      await expect(helper.postMessage('C123', 'Hello')).rejects.toThrow('API error');
    });
  });

  describe('updateMessage', () => {
    it('should update message', async () => {
      mockApp.client.chat.update.mockResolvedValue({});

      await helper.updateMessage('C123', '123.456', 'Updated');

      expect(mockApp.client.chat.update).toHaveBeenCalledWith({
        channel: 'C123',
        ts: '123.456',
        text: 'Updated',
        blocks: undefined,
        attachments: undefined,
      });
    });

    it('should include blocks when provided', async () => {
      mockApp.client.chat.update.mockResolvedValue({});

      await helper.updateMessage('C123', '123.456', 'Updated', [{ type: 'section' }]);

      expect(mockApp.client.chat.update).toHaveBeenCalledWith({
        channel: 'C123',
        ts: '123.456',
        text: 'Updated',
        blocks: [{ type: 'section' }],
        attachments: undefined,
      });
    });
  });

  describe('postEphemeral', () => {
    it('should post ephemeral message', async () => {
      mockApp.client.chat.postEphemeral.mockResolvedValue({ message_ts: '123.456' });

      const result = await helper.postEphemeral('C123', 'U456', 'Only you can see this');

      expect(mockApp.client.chat.postEphemeral).toHaveBeenCalledWith({
        channel: 'C123',
        user: 'U456',
        text: 'Only you can see this',
        thread_ts: undefined,
      });
      expect(result).toEqual({ ts: '123.456' });
    });

    it('should include threadTs when provided', async () => {
      mockApp.client.chat.postEphemeral.mockResolvedValue({ message_ts: '789.101' });

      const result = await helper.postEphemeral('C123', 'U456', 'Hello', '111.222');

      expect(mockApp.client.chat.postEphemeral).toHaveBeenCalledWith({
        channel: 'C123',
        user: 'U456',
        text: 'Hello',
        thread_ts: '111.222',
      });
      expect(result).toEqual({ ts: '789.101' });
    });
  });

  describe('addReaction', () => {
    it('should add reaction and return true on success', async () => {
      mockApp.client.reactions.add.mockResolvedValue({});

      const result = await helper.addReaction('C123', '123.456', 'thumbsup');

      expect(result).toBe(true);
      expect(mockApp.client.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '123.456',
        name: 'thumbsup',
      });
    });

    it('should return true on already_reacted error', async () => {
      mockApp.client.reactions.add.mockRejectedValue({
        data: { error: 'already_reacted' },
      });

      const result = await helper.addReaction('C123', '123.456', 'thumbsup');
      expect(result).toBe(true);
    });

    it('should return false on other errors', async () => {
      mockApp.client.reactions.add.mockRejectedValue({
        data: { error: 'channel_not_found' },
      });

      const result = await helper.addReaction('C123', '123.456', 'thumbsup');
      expect(result).toBe(false);
    });
  });

  describe('removeReaction', () => {
    it('should remove reaction', async () => {
      mockApp.client.reactions.remove.mockResolvedValue({});

      await helper.removeReaction('C123', '123.456', 'thumbsup');

      expect(mockApp.client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '123.456',
        name: 'thumbsup',
      });
    });

    it('should not throw on no_reaction error', async () => {
      mockApp.client.reactions.remove.mockRejectedValue({
        data: { error: 'no_reaction' },
      });

      await expect(helper.removeReaction('C123', '123.456', 'thumbsup')).resolves.not.toThrow();
    });
  });
});
