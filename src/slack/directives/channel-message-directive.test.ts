import { describe, it, expect } from 'vitest';
import { ChannelMessageDirectiveHandler } from './channel-message-directive';

describe('ChannelMessageDirectiveHandler', () => {
  describe('extract', () => {
    it('should return null for plain text', () => {
      const result = ChannelMessageDirectiveHandler.extract('hello');
      expect(result.messageText).toBeNull();
      expect(result.cleanedText).toBe('hello');
    });

    it('should extract text from json code block', () => {
      const text = `Release done
\`\`\`json
{
  "type": "channel_message",
  "text": "## Release Notes\\n- item 1"
}
\`\`\`
Thread summary`;

      const result = ChannelMessageDirectiveHandler.extract(text);
      expect(result.messageText).toBe('## Release Notes\n- item 1');
      expect(result.cleanedText).toBe('Release done\n\nThread summary');
    });

    it('should extract from raw JSON', () => {
      const text = `Done.
{"type":"channel_message","text":"Root post"}
What next?`;

      const result = ChannelMessageDirectiveHandler.extract(text);
      expect(result.messageText).toBe('Root post');
      expect(result.cleanedText).toBe('Done.\n\nWhat next?');
    });

    it('should support message/content aliases', () => {
      const messageResult = ChannelMessageDirectiveHandler.extract(
        '{"type":"channel_message","message":"alias message"}'
      );
      const contentResult = ChannelMessageDirectiveHandler.extract(
        '{"type":"channel_message","content":"alias content"}'
      );

      expect(messageResult.messageText).toBe('alias message');
      expect(contentResult.messageText).toBe('alias content');
    });

    it('should ignore wrong type', () => {
      const result = ChannelMessageDirectiveHandler.extract(
        '{"type":"session_links","pr":"https://github.com/org/repo/pull/1"}'
      );

      expect(result.messageText).toBeNull();
    });

    it('should ignore empty text payload', () => {
      const result = ChannelMessageDirectiveHandler.extract(
        '{"type":"channel_message","text":"   "}'
      );

      expect(result.messageText).toBeNull();
    });

    it('should prefer json code block when both exist', () => {
      const text = `{"type":"channel_message","text":"raw"}
\`\`\`json
{"type":"channel_message","text":"code"}
\`\`\``;

      const result = ChannelMessageDirectiveHandler.extract(text);
      expect(result.messageText).toBe('code');
    });
  });
});
