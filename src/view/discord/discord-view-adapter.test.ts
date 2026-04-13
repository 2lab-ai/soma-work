/**
 * DiscordViewAdapter tests (Issue #414)
 */

import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '../types.js';
import {
  type DiscordClientApi,
  type DiscordMessageRef,
  DiscordViewAdapter,
  discordMessageHandle,
  discordTarget,
  extractDiscordRef,
} from './discord-view-adapter.js';

// ─── Helpers ────────────────────────────────────────────────────

function createMockClient(): DiscordClientApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ id: 'msg-42' }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockResolvedValue({ id: 'thread-99' }),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue('modal-1'),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('DiscordViewAdapter', () => {
  it('reports platform as discord', () => {
    const adapter = new DiscordViewAdapter();
    expect(adapter.platform).toBe('discord');
  });

  describe('ref helpers', () => {
    it('creates and extracts conversation ref', () => {
      const target = discordTarget('guild-1', 'ch-1', 'U001');
      const ref = extractDiscordRef(target);

      expect(ref.guildId).toBe('guild-1');
      expect(ref.channelId).toBe('ch-1');
      expect(ref.threadId).toBeUndefined();
      expect(target.userId).toBe('U001');
    });

    it('creates ref with threadId', () => {
      const target = discordTarget('guild-1', 'ch-1', 'U001', 'thread-1');
      const ref = extractDiscordRef(target);

      expect(ref.threadId).toBe('thread-1');
    });

    it('creates message handle', () => {
      const handle = discordMessageHandle('ch-1', 'msg-1');

      expect(handle.platform).toBe('discord');
      expect((handle.ref as DiscordMessageRef).channelId).toBe('ch-1');
      expect((handle.ref as DiscordMessageRef).messageId).toBe('msg-1');
    });
  });

  describe('featuresFor', () => {
    it('returns full capabilities', () => {
      const adapter = new DiscordViewAdapter();
      const target = discordTarget('guild-1', 'ch-1', 'U001');
      const features = adapter.featuresFor(target);

      expect(features.canEdit).toBe(true);
      expect(features.canThread).toBe(true);
      expect(features.canReact).toBe(true);
      expect(features.canModal).toBe(true);
      expect(features.canUploadFile).toBe(true);
      expect(features.canEphemeral).toBe(true);
      expect(features.maxMessageLength).toBe(2000);
      expect(features.maxFileSize).toBe(25 * 1024 * 1024);
    });
  });

  describe('postMessage', () => {
    it('sends message via client API', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const target = discordTarget('guild-1', 'ch-1', 'U001');
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello Discord!' }];

      const handle = await adapter.postMessage(target, blocks);

      expect(client.sendMessage).toHaveBeenCalledWith('ch-1', 'Hello Discord!');
      expect(handle.platform).toBe('discord');
      expect((handle.ref as DiscordMessageRef).messageId).toBe('msg-42');
    });

    it('sends to thread channel when threadId is set', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const target = discordTarget('guild-1', 'ch-1', 'U001', 'thread-5');
      const blocks: ContentBlock[] = [{ type: 'text', text: 'In thread' }];

      await adapter.postMessage(target, blocks);

      expect(client.sendMessage).toHaveBeenCalledWith('thread-5', 'In thread');
    });

    it('returns stub handle without client', async () => {
      const adapter = new DiscordViewAdapter();
      const target = discordTarget('guild-1', 'ch-1', 'U001');
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello' }];

      const handle = await adapter.postMessage(target, blocks);

      expect(handle.platform).toBe('discord');
      expect((handle.ref as DiscordMessageRef).messageId).toBe('0');
    });
  });

  describe('beginResponse', () => {
    it('collects text and posts on complete', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const target = discordTarget('guild-1', 'ch-1', 'U001');

      const session = adapter.beginResponse(target);
      session.appendText('Hello ');
      session.appendText('Discord');
      const handle = await session.complete();

      expect(client.sendMessage).toHaveBeenCalledWith('ch-1', 'Hello Discord');
      expect(handle.platform).toBe('discord');
    });

    it('does not append text after abort', () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const target = discordTarget('guild-1', 'ch-1', 'U001');

      const session = adapter.beginResponse(target);
      session.appendText('Hello');
      session.abort('cancelled');
      session.appendText(' world');

      expect(client.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('Editable', () => {
    it('edits message via client API', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const handle = discordMessageHandle('ch-1', 'msg-42');
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Updated' }];

      await adapter.updateMessage(handle, blocks);

      expect(client.editMessage).toHaveBeenCalledWith('ch-1', 'msg-42', 'Updated');
    });

    it('deletes message via client API', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const handle = discordMessageHandle('ch-1', 'msg-42');

      await adapter.deleteMessage(handle);

      expect(client.deleteMessage).toHaveBeenCalledWith('ch-1', 'msg-42');
    });
  });

  describe('Threadable', () => {
    it('creates thread via client API', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const target = discordTarget('guild-1', 'ch-1', 'U001');

      const threadTarget = await adapter.createThread(target, [{ type: 'text', text: 'Start thread' }]);

      expect(client.createThread).toHaveBeenCalledWith('ch-1', 'Start thread');
      const ref = extractDiscordRef(threadTarget);
      expect(ref.threadId).toBe('thread-99');
      expect(ref.guildId).toBe('guild-1');
      expect(threadTarget.userId).toBe('U001');
    });

    it('returns stub thread without client', async () => {
      const adapter = new DiscordViewAdapter();
      const target = discordTarget('guild-1', 'ch-1', 'U001');

      const threadTarget = await adapter.createThread(target, []);
      const ref = extractDiscordRef(threadTarget);

      expect(ref.threadId).toMatch(/^thread-/);
    });
  });

  describe('Reactable', () => {
    it('adds reaction via client API', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const handle = discordMessageHandle('ch-1', 'msg-42');

      await adapter.addReaction(handle, '👍');

      expect(client.addReaction).toHaveBeenCalledWith('ch-1', 'msg-42', '👍');
    });

    it('removes reaction via client API', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const handle = discordMessageHandle('ch-1', 'msg-42');

      await adapter.removeReaction(handle, '👍');

      expect(client.removeReaction).toHaveBeenCalledWith('ch-1', 'msg-42', '👍');
    });

    it('is safe to call without client', async () => {
      const adapter = new DiscordViewAdapter();
      const handle = discordMessageHandle('ch-1', 'msg-42');

      await adapter.addReaction(handle, '🎉');
      await adapter.removeReaction(handle, '🎉');
    });
  });

  describe('HasModals', () => {
    it('opens form and returns formId', async () => {
      const client = createMockClient();
      const adapter = new DiscordViewAdapter(client);
      const target = discordTarget('guild-1', 'ch-1', 'U001');

      const formId = await adapter.openForm(target, {
        title: 'Settings',
        fields: [{ id: 'name', fieldType: 'text', label: 'Name' }],
      });

      expect(formId).toMatch(/^discord-form-/);
      expect(client.showModal).toHaveBeenCalled();
    });

    it('returns formId without client', async () => {
      const adapter = new DiscordViewAdapter();
      const target = discordTarget('guild-1', 'ch-1', 'U001');

      const formId = await adapter.openForm(target, {
        title: 'Test',
        fields: [],
      });

      expect(formId).toMatch(/^discord-form-/);
    });

    it('updateForm and closeForm are safe no-ops', async () => {
      const adapter = new DiscordViewAdapter();

      // Should not throw
      await adapter.updateForm('form-1', { title: 'T', fields: [] });
      await adapter.closeForm('form-1');
    });
  });
});
