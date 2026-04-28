/**
 * Trace: docs/usage-card-dark/trace.md
 *   - Scenario 8  (happy path — owner click, chat.update)
 *   - Scenario 9  (non-owner click — ephemeral reject)
 *   - Scenario 11 (TabCache miss — ephemeral "session expired")
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabId } from '../../../metrics/usage-render/types';
import { TabCache } from '../../commands/usage-carousel-cache';
import { UsageCardActionHandler } from '../usage-card-action-handler';

const DEFAULT_FILE_IDS: Record<TabId, string> = {
  '24h': 'F_24',
  '7d': 'F_7',
  '30d': 'F_30',
  all: 'F_ALL',
  models: 'F_MODELS',
};

function makeTabCache(entries: Record<string, { fileIds?: Record<TabId, string>; userId: string }> = {}): TabCache {
  const cache = new TabCache();
  const now = Date.now();
  for (const [ts, v] of Object.entries(entries)) {
    cache.set(ts, {
      fileIds: v.fileIds ?? DEFAULT_FILE_IDS,
      userId: v.userId,
      expiresAt: now + 3_600_000,
    });
  }
  return cache;
}

function makeBody({
  messageTs = 'MSG1' as string | undefined,
  channel = 'C1' as string | undefined,
  userId = 'U_OWNER' as string | undefined,
  tab = '7d' as unknown,
}: {
  messageTs?: string;
  channel?: string;
  userId?: string;
  tab?: unknown;
} = {}) {
  return {
    container: { message_ts: messageTs, channel_id: channel },
    user: { id: userId },
    actions: [{ value: tab }],
  };
}

function makeClient(updateImpl?: (args: any) => Promise<any>) {
  return {
    chat: {
      update: vi.fn(updateImpl ?? (async () => ({ ok: true }))),
    },
  };
}

describe('UsageCardActionHandler', () => {
  let handler: UsageCardActionHandler;
  let tabCache: TabCache;
  let mockRespond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tabCache = makeTabCache({ MSG1: { userId: 'U_OWNER' } });
    handler = new UsageCardActionHandler({ tabCache });
    mockRespond = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Scenario 8 — happy path ──────────────────────────────────────
  describe('happy path (Scenario 8)', () => {
    it('calls client.chat.update with rebuilt blocks for the selected tab', async () => {
      const client = makeClient();
      const body = makeBody({ userId: 'U_OWNER', tab: '7d' });

      await handler.handleTabClick(body, client, mockRespond);

      expect(client.chat.update).toHaveBeenCalledTimes(1);
      const call = client.chat.update.mock.calls[0][0];
      expect(call.channel).toBe('C1');
      expect(call.ts).toBe('MSG1');

      const blocks = call.blocks as any[];
      // [context, image, actions]
      expect(blocks).toHaveLength(3);

      // image swap
      expect(blocks[1].slack_file.id).toBe(DEFAULT_FILE_IDS['7d']);

      // actions block_id is static
      expect(blocks[2].block_id).toBe('usage_card_tabs');

      // 7d is the 2nd button (index 1) in ['24h','7d','30d','all','models']
      const buttons = blocks[2].elements as any[];
      expect(buttons).toHaveLength(5);
      expect(buttons[1].value).toBe('7d');
      expect(buttons[1].style).toBe('primary');
      expect(buttons[0].style).toBeUndefined();
      expect(buttons[2].style).toBeUndefined();
      expect(buttons[3].style).toBeUndefined();
      expect(buttons[4].style).toBeUndefined();

      // respond NOT called
      expect(mockRespond).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 9 — non-owner ───────────────────────────────────────
  describe('non-owner (Scenario 9)', () => {
    it('responds ephemeral with 본인 text and does NOT call chat.update', async () => {
      const client = makeClient();
      const body = makeBody({ userId: 'U_INTRUDER', tab: '7d' });

      await handler.handleTabClick(body, client, mockRespond);

      expect(client.chat.update).not.toHaveBeenCalled();
      expect(mockRespond).toHaveBeenCalledTimes(1);
      const call = mockRespond.mock.calls[0][0];
      expect(call.response_type).toBe('ephemeral');
      expect(call.replace_original).toBe(false);
      expect(call.text).toContain('본인');

      // Cache entry untouched (get returns same entry; spec allows move-to-end).
      expect(tabCache.size()).toBe(1);
      expect(tabCache.get('MSG1')?.userId).toBe('U_OWNER');
    });
  });

  // ── Scenario 11 — TabCache miss ──────────────────────────────────
  describe('cache miss (Scenario 11)', () => {
    it('responds ephemeral with 만료 text and does NOT call chat.update', async () => {
      const emptyHandler = new UsageCardActionHandler({ tabCache: new TabCache() });
      const client = makeClient();
      const body = makeBody({ messageTs: 'UNKNOWN_TS', userId: 'U_ANY', tab: '24h' });

      await emptyHandler.handleTabClick(body, client, mockRespond);

      expect(client.chat.update).not.toHaveBeenCalled();
      expect(mockRespond).toHaveBeenCalledTimes(1);
      const call = mockRespond.mock.calls[0][0];
      expect(call.response_type).toBe('ephemeral');
      expect(call.replace_original).toBe(false);
      expect(call.text).toContain('만료');
    });
  });

  // ── Unknown tab value ────────────────────────────────────────────
  it('returns silently on unknown tab value (no respond, no update)', async () => {
    const client = makeClient();
    const body = makeBody({ userId: 'U_OWNER', tab: 'bogus' });

    await handler.handleTabClick(body, client, mockRespond);

    expect(client.chat.update).not.toHaveBeenCalled();
    expect(mockRespond).not.toHaveBeenCalled();
  });

  // ── Malformed payload ────────────────────────────────────────────
  it('returns silently when container.message_ts is missing', async () => {
    const client = makeClient();
    const body = {
      // container omitted
      user: { id: 'U_OWNER' },
      actions: [{ value: '7d' }],
    };

    await handler.handleTabClick(body, client, mockRespond);

    expect(client.chat.update).not.toHaveBeenCalled();
    expect(mockRespond).not.toHaveBeenCalled();
  });

  // ── chat.update throws ───────────────────────────────────────────
  it('catches chat.update failure, logs, and sends ephemeral 실패 fallback', async () => {
    const client = makeClient(async () => {
      throw new Error('slack 500');
    });
    const body = makeBody({ userId: 'U_OWNER', tab: '30d' });

    await expect(handler.handleTabClick(body, client, mockRespond)).resolves.toBeUndefined();

    expect(client.chat.update).toHaveBeenCalledTimes(1);
    expect(mockRespond).toHaveBeenCalledTimes(1);
    const call = mockRespond.mock.calls[0][0];
    expect(call.response_type).toBe('ephemeral');
    expect(call.replace_original).toBe(false);
    expect(call.text).toContain('실패');
  });

  // ── Static block_id (Scenario 8 contract line 232) ───────────────
  it('emits static block_id "usage_card_tabs" (not messageTs-embedded)', async () => {
    const client = makeClient();
    const body = makeBody({ messageTs: 'MSG1', userId: 'U_OWNER', tab: '7d' });

    await handler.handleTabClick(body, client, mockRespond);

    const blocks = client.chat.update.mock.calls[0][0].blocks as any[];
    expect(blocks[2].block_id).toBe('usage_card_tabs');
    expect(blocks[2].block_id).not.toContain('MSG1');
  });

  // ── Models tab click — happy path ────────────────────────────────
  describe('models tab (Scenario 8 extension)', () => {
    it('owner click on models button → chat.update with models image + models primary', async () => {
      const client = makeClient();
      const body = makeBody({ userId: 'U_OWNER', tab: 'models' });

      await handler.handleTabClick(body, client, mockRespond);

      expect(client.chat.update).toHaveBeenCalledTimes(1);
      const blocks = client.chat.update.mock.calls[0][0].blocks as any[];

      // Image points at the models PNG
      expect(blocks[1].slack_file.id).toBe(DEFAULT_FILE_IDS.models);

      // 5 buttons; only models is primary
      const buttons = blocks[2].elements as any[];
      expect(buttons).toHaveLength(5);
      expect(buttons[4].value).toBe('models');
      expect(buttons[4].style).toBe('primary');
      for (const b of buttons.slice(0, 4)) {
        expect(b.style).toBeUndefined();
      }

      expect(mockRespond).not.toHaveBeenCalled();
    });
  });

  // ── Selected tab image swap + primary highlight movement ────────
  it('swaps image file + primary highlight as selected tab changes', async () => {
    const client24 = makeClient();
    const client30 = makeClient();

    const body24 = makeBody({ userId: 'U_OWNER', tab: '24h' });
    await handler.handleTabClick(body24, client24, mockRespond);

    // Cache was consumed + re-added (move-to-end); still valid for the 2nd call.
    const body30 = makeBody({ userId: 'U_OWNER', tab: '30d' });
    await handler.handleTabClick(body30, client30, mockRespond);

    const blocks24 = client24.chat.update.mock.calls[0][0].blocks as any[];
    const blocks30 = client30.chat.update.mock.calls[0][0].blocks as any[];

    // image swap
    expect(blocks24[1].slack_file.id).toBe(DEFAULT_FILE_IDS['24h']);
    expect(blocks30[1].slack_file.id).toBe(DEFAULT_FILE_IDS['30d']);

    // primary highlight movement
    const buttons24 = blocks24[2].elements as any[];
    const buttons30 = blocks30[2].elements as any[];

    // 24h-selected: button[0] is primary, button[2] (30d) is not
    expect(buttons24[0].value).toBe('24h');
    expect(buttons24[0].style).toBe('primary');
    expect(buttons24[2].style).toBeUndefined();

    // 30d-selected: button[2] is primary, button[0] (24h) is not
    expect(buttons30[0].value).toBe('24h');
    expect(buttons30[0].style).toBeUndefined();
    expect(buttons30[2].value).toBe('30d');
    expect(buttons30[2].style).toBe('primary');
  });
});
