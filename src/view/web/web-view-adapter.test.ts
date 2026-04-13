/**
 * WebViewAdapter tests (Issue #412)
 */

import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '../types.js';
import { extractWebRef, webMessageHandle, webTarget } from './web-refs.js';
import type { WebSocketBroadcaster } from './web-response-session.js';
import { WebViewAdapter } from './web-view-adapter.js';

// ─── Helpers ────────────────────────────────────────────────────

function createMockBroadcaster(): WebSocketBroadcaster & {
  messages: Array<{ key: string; msg: Record<string, unknown> }>;
} {
  const messages: Array<{ key: string; msg: Record<string, unknown> }> = [];
  return {
    messages,
    send: vi.fn((key: string, msg: Record<string, unknown>) => {
      messages.push({ key, msg });
    }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('WebViewAdapter', () => {
  it('reports platform as web', () => {
    const broadcaster = createMockBroadcaster();
    const adapter = new WebViewAdapter(broadcaster);
    expect(adapter.platform).toBe('web');
  });

  describe('featuresFor', () => {
    it('returns full capabilities', () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const target = webTarget('sess-1', 'U123');

      const features = adapter.featuresFor(target);

      expect(features.canEdit).toBe(true);
      expect(features.canThread).toBe(true);
      expect(features.canReact).toBe(true);
      expect(features.canModal).toBe(true);
      expect(features.canUploadFile).toBe(true);
      expect(features.canEphemeral).toBe(false);
      expect(features.maxMessageLength).toBe(0); // Unlimited
    });
  });

  describe('postMessage', () => {
    it('broadcasts message to session', async () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const target = webTarget('sess-1', 'U123');
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello web!' }];

      const handle = await adapter.postMessage(target, blocks);

      expect(broadcaster.send).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'message',
          sessionKey: 'sess-1',
          blocks,
        }),
      );
      expect(handle.platform).toBe('web');
    });
  });

  describe('beginResponse', () => {
    it('returns a WebResponseSession', () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const target = webTarget('sess-1', 'U123');

      const session = adapter.beginResponse(target);

      expect(session).toBeDefined();
      expect(session.appendText).toBeDefined();
      expect(session.complete).toBeDefined();
      // Should have sent response_start
      expect(broadcaster.send).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'response_start',
        }),
      );
    });
  });

  describe('Editable', () => {
    it('broadcasts message update', async () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const handle = webMessageHandle('sess-1', 'msg-1');
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Updated' }];

      await adapter.updateMessage(handle, blocks);

      expect(broadcaster.send).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'message_update',
          messageId: 'msg-1',
          blocks,
        }),
      );
    });

    it('broadcasts message delete', async () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const handle = webMessageHandle('sess-1', 'msg-1');

      await adapter.deleteMessage(handle);

      expect(broadcaster.send).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'message_delete',
          messageId: 'msg-1',
        }),
      );
    });
  });

  describe('Threadable', () => {
    it('creates thread and returns new target', async () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const target = webTarget('sess-1', 'U123');

      const threadTarget = await adapter.createThread(target, []);

      expect(threadTarget.platform).toBe('web');
      expect(threadTarget.userId).toBe('U123');
      const ref = extractWebRef(threadTarget);
      expect(ref.sessionKey).toBe('sess-1');
      expect(ref.threadId).toMatch(/^thread-/);
      expect(broadcaster.send).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'thread_created',
        }),
      );
    });
  });

  describe('Reactable', () => {
    it('broadcasts reaction add', async () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const handle = webMessageHandle('sess-1', 'msg-1');

      await adapter.addReaction(handle, 'thumbsup');

      expect(broadcaster.send).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'reaction_add',
          emoji: 'thumbsup',
        }),
      );
    });

    it('broadcasts reaction remove', async () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const handle = webMessageHandle('sess-1', 'msg-1');

      await adapter.removeReaction(handle, 'thumbsup');

      expect(broadcaster.send).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'reaction_remove',
          emoji: 'thumbsup',
        }),
      );
    });
  });

  describe('HasModals', () => {
    it('opens form and returns formId', async () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);
      const target = webTarget('sess-1', 'U123');

      const formId = await adapter.openForm(target, {
        title: 'Settings',
        fields: [{ id: 'name', fieldType: 'text', label: 'Name' }],
      });

      expect(formId).toMatch(/^form-/);
      expect(broadcaster.send).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'form_open',
          formId,
        }),
      );
    });

    it('closes form', async () => {
      const broadcaster = createMockBroadcaster();
      const adapter = new WebViewAdapter(broadcaster);

      await adapter.closeForm('form-123');

      expect(broadcaster.send).toHaveBeenCalledWith(
        '*',
        expect.objectContaining({
          type: 'form_close',
          formId: 'form-123',
        }),
      );
    });
  });
});
