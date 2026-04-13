/**
 * SlackViewAdapter tests (Issue #409)
 */

import { describe, expect, it, vi } from 'vitest';
import { hasModals, isEditable, isReactable, isThreadable } from '../surface.js';
import type { ContentBlock, ConversationTarget } from '../types.js';
import { slackMessageHandle, slackTarget } from './slack-refs.js';
import { type SlackApiForView, SlackViewAdapter } from './slack-view-adapter.js';

// ─── Mock SlackApiForView ────────────────────────────────────────

function createMockSlackApi(): SlackApiForView {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '1700000000.000100', channel: 'C123' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(true),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    getClient: vi.fn().mockReturnValue({}),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('SlackViewAdapter', () => {
  const target = slackTarget('U123', 'C456', '1700000000.000000');

  it('reports platform as slack', () => {
    const api = createMockSlackApi();
    const adapter = new SlackViewAdapter(api);
    expect(adapter.platform).toBe('slack');
  });

  describe('type guards', () => {
    it('satisfies all capability interfaces', () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);
      expect(isEditable(adapter)).toBe(true);
      expect(isThreadable(adapter)).toBe(true);
      expect(isReactable(adapter)).toBe(true);
      expect(hasModals(adapter)).toBe(true);
    });
  });

  describe('postMessage', () => {
    it('posts text content to Slack', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);

      const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello World' }];
      const handle = await adapter.postMessage(target, blocks);

      expect(api.postMessage).toHaveBeenCalledWith('C456', 'Hello World', {
        threadTs: '1700000000.000000',
      });
      expect(handle.platform).toBe('slack');
    });

    it('renders code blocks with fences', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);

      const blocks: ContentBlock[] = [{ type: 'text', text: 'const x = 1;', format: 'code', language: 'typescript' }];
      await adapter.postMessage(target, blocks);

      expect(api.postMessage).toHaveBeenCalledWith('C456', '```typescript\nconst x = 1;\n```', expect.any(Object));
    });

    it('renders status blocks as italic text', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);

      const blocks: ContentBlock[] = [{ type: 'status', phase: '생각 중', tool: 'Bash' }];
      await adapter.postMessage(target, blocks);

      expect(api.postMessage).toHaveBeenCalledWith('C456', '_생각 중 (Bash)_', expect.any(Object));
    });

    it('renders multiple blocks joined by newlines', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);

      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Line 1' },
        { type: 'text', text: 'Line 2' },
      ];
      await adapter.postMessage(target, blocks);

      expect(api.postMessage).toHaveBeenCalledWith('C456', 'Line 1\nLine 2', expect.any(Object));
    });

    it('throws if Slack does not return a timestamp', async () => {
      const api = createMockSlackApi();
      (api.postMessage as any).mockResolvedValue({ ts: undefined });
      const adapter = new SlackViewAdapter(api);

      await expect(adapter.postMessage(target, [{ type: 'text', text: 'x' }])).rejects.toThrow(
        'did not return a timestamp',
      );
    });
  });

  describe('updateMessage', () => {
    it('delegates to SlackApiHelper.updateMessage', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);
      const handle = slackMessageHandle('C456', '1700000000.000200');

      await adapter.updateMessage(handle, [{ type: 'text', text: 'Updated' }]);

      expect(api.updateMessage).toHaveBeenCalledWith('C456', '1700000000.000200', 'Updated');
    });
  });

  describe('deleteMessage', () => {
    it('delegates to SlackApiHelper.deleteMessage', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);
      const handle = slackMessageHandle('C456', '1700000000.000200');

      await adapter.deleteMessage(handle);

      expect(api.deleteMessage).toHaveBeenCalledWith('C456', '1700000000.000200');
    });
  });

  describe('createThread', () => {
    it('posts root message and returns thread-scoped target', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);

      const threadTarget = await adapter.createThread(target, [{ type: 'text', text: 'Thread root' }]);

      expect(api.postMessage).toHaveBeenCalledWith('C456', 'Thread root');
      expect(threadTarget.platform).toBe('slack');
      expect(threadTarget.userId).toBe('U123');
    });
  });

  describe('addReaction / removeReaction', () => {
    it('adds reaction via SlackApiHelper', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);
      const handle = slackMessageHandle('C456', '1700000000.000200');

      await adapter.addReaction(handle, 'brain');

      expect(api.addReaction).toHaveBeenCalledWith('C456', '1700000000.000200', 'brain');
    });

    it('removes reaction via SlackApiHelper', async () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);
      const handle = slackMessageHandle('C456', '1700000000.000200');

      await adapter.removeReaction(handle, 'brain');

      expect(api.removeReaction).toHaveBeenCalledWith('C456', '1700000000.000200', 'brain');
    });
  });

  describe('featuresFor', () => {
    it('returns full features for channel targets', () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);
      const channelTarget = slackTarget('U123', 'C456');

      const features = adapter.featuresFor(channelTarget);

      expect(features.canEdit).toBe(true);
      expect(features.canThread).toBe(true);
      expect(features.canReact).toBe(true);
      expect(features.canModal).toBe(true);
      expect(features.maxMessageLength).toBe(4000);
    });

    it('returns limited features for DM targets', () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);
      const dmTarget = slackTarget('U123', 'D789');

      const features = adapter.featuresFor(dmTarget);

      expect(features.canThread).toBe(false);
      expect(features.canEphemeral).toBe(false);
    });

    it('throws for non-Slack targets', () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);
      const webTarget: ConversationTarget = {
        platform: 'web',
        ref: { sessionId: 'abc' },
        userId: 'U123',
      };

      expect(() => adapter.featuresFor(webTarget)).toThrow('Expected Slack target');
    });
  });

  describe('beginResponse', () => {
    it('returns a ResponseSession', () => {
      const api = createMockSlackApi();
      const adapter = new SlackViewAdapter(api);

      const session = adapter.beginResponse(target);

      expect(session).toBeDefined();
      expect(typeof session.appendText).toBe('function');
      expect(typeof session.setStatus).toBe('function');
      expect(typeof session.complete).toBe('function');
      expect(typeof session.abort).toBe('function');
    });
  });
});
