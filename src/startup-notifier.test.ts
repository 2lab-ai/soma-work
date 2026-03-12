import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VersionInfo } from './release-notifier';
import { LEGACY_STARTUP_CHANNEL_ID, notifyStartup } from './startup-notifier';

const createMockClient = () => ({
  conversations: {
    list: vi.fn(),
  },
  chat: {
    postMessage: vi.fn(),
  },
});

describe('notifyStartup', () => {
  const originalDefaultUpdateChannel = process.env.DEFAULT_UPDATE_CHANNEL;
  const versionInfo: VersionInfo = {
    version: '0.2.45',
    previousVersion: '0.2.44',
    tag: 'v0.2.45-dev',
    previousTag: 'v0.2.44-dev',
    commitHash: '9815876215be5d947801234567890123456789ab',
    commitHashShort: '9815876',
    commitTime: '2026-03-11T02:35:00.000Z',
    branch: 'dev',
    buildTime: '2026-03-11T02:35:30.000Z',
    releaseNotes: '• 9815876 fix: startup channel selection',
  };

  beforeEach(() => {
    delete process.env.DEFAULT_UPDATE_CHANNEL;
  });

  afterEach(() => {
    if (originalDefaultUpdateChannel === undefined) {
      delete process.env.DEFAULT_UPDATE_CHANNEL;
    } else {
      process.env.DEFAULT_UPDATE_CHANNEL = originalDefaultUpdateChannel;
    }
    vi.restoreAllMocks();
  });

  it('posts startup notifications to DEFAULT_UPDATE_CHANNEL when configured', async () => {
    process.env.DEFAULT_UPDATE_CHANNEL = '#deploy-updates';

    const client = createMockClient();
    client.conversations.list.mockResolvedValue({
      channels: [{ id: 'CDEPLOY', name: 'deploy-updates' }],
    });
    client.chat.postMessage.mockResolvedValue({ ok: true });

    await notifyStartup(client as any, {
      loadedSessions: 16,
      mcpNames: ['jira', 'codex'],
      versionInfo,
    });

    expect(client.conversations.list).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'CDEPLOY',
      text: 'Bot Started - v0.2.45 (dev)',
    }));
  });

  it('falls back to the legacy startup channel when DEFAULT_UPDATE_CHANNEL is missing', async () => {
    const client = createMockClient();
    client.chat.postMessage.mockResolvedValue({ ok: true });

    await notifyStartup(client as any, {
      loadedSessions: 0,
      mcpNames: [],
      versionInfo,
    });

    expect(client.conversations.list).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: LEGACY_STARTUP_CHANNEL_ID,
      text: 'Bot Started - v0.2.45 (dev)',
    }));
  });
});
