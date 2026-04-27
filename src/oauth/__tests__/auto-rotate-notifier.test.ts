import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyAutoRotation } from '../auto-rotate-notifier';

vi.mock('../../logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    debug = vi.fn();
    error = vi.fn();
  },
}));

// release-notifier is the source of getConfiguredUpdateChannel + resolveChannel.
// We mock both so notifier tests don't require an env file or live Slack.
vi.mock('../../release-notifier', () => ({
  getConfiguredUpdateChannel: vi.fn(),
  resolveChannel: vi.fn(),
}));

import { getConfiguredUpdateChannel, resolveChannel } from '../../release-notifier';

const fakeChannelId = 'C0000ABCDE';

type PostFn = (args: { channel: string; text: string; blocks: unknown[] }) => Promise<unknown>;

function makeClient(overrides: { post?: ReturnType<typeof vi.fn> } = {}): {
  chat: { postMessage: ReturnType<typeof vi.fn> };
} {
  const post = overrides.post ?? vi.fn<PostFn>(async () => ({ ok: true }));
  return {
    chat: { postMessage: post },
  };
}

function asNotifyClient(client: {
  chat: { postMessage: ReturnType<typeof vi.fn> };
}): Parameters<typeof notifyAutoRotation>[0] {
  return client as unknown as Parameters<typeof notifyAutoRotation>[0];
}

const candidate = {
  keyId: 'b',
  name: 'B',
  sevenDayResetsAt: '2026-04-28T00:00:00Z',
  sevenDayResetsAtMs: new Date('2026-04-28T00:00:00Z').getTime(),
  fiveHourUtilization: 0.42,
  sevenDayUtilization: 0.55,
};

const activeSummary = {
  keyId: 'a',
  name: 'A',
  fiveHourUtilization: 0.7,
  sevenDayUtilization: 0.8,
  sevenDayResetsAt: '2026-05-01T00:00:00Z',
};

describe('notifyAutoRotation (#737)', () => {
  beforeEach(() => {
    vi.mocked(getConfiguredUpdateChannel).mockReset();
    vi.mocked(resolveChannel).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false (and does not call chat.postMessage) when DEFAULT_UPDATE_CHANNEL is unset', async () => {
    vi.mocked(getConfiguredUpdateChannel).mockReturnValue(undefined);
    const client = makeClient();
    const result = await notifyAutoRotation(asNotifyClient(client), { from: activeSummary, to: candidate });
    expect(result).toBe(false);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns false when channel cannot be resolved (warn-and-skip)', async () => {
    vi.mocked(getConfiguredUpdateChannel).mockReturnValue('#missing-channel');
    vi.mocked(resolveChannel).mockResolvedValue(null);
    const client = makeClient();
    const result = await notifyAutoRotation(asNotifyClient(client), { from: activeSummary, to: candidate });
    expect(result).toBe(false);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('posts to resolved channel id with from/to in the message', async () => {
    vi.mocked(getConfiguredUpdateChannel).mockReturnValue('#ops-updates');
    vi.mocked(resolveChannel).mockResolvedValue(fakeChannelId);
    const post = vi.fn(async (_args: { channel: string; text: string; blocks: unknown[] }) => ({ ok: true }));
    const client = makeClient({ post });

    const result = await notifyAutoRotation(asNotifyClient(client), { from: activeSummary, to: candidate });
    expect(result).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const arg = post.mock.calls[0][0] as { channel: string; text: string; blocks: unknown[] };
    expect(arg.channel).toBe(fakeChannelId);
    expect(arg.text).toContain('Auto CCT rotation');
    expect(arg.text).toContain('A');
    expect(arg.text).toContain('B');
    const blockText = JSON.stringify(arg.blocks);
    expect(blockText).toContain('A');
    expect(blockText).toContain('B');
    expect(blockText).toContain('42.0%');
    expect(blockText).toContain('55.0%');
  });

  it('posts even when from is null (first-boot rotation)', async () => {
    vi.mocked(getConfiguredUpdateChannel).mockReturnValue(fakeChannelId);
    vi.mocked(resolveChannel).mockResolvedValue(fakeChannelId);
    const post = vi.fn(async (_args: { channel: string; text: string; blocks: unknown[] }) => ({ ok: true }));
    const client = makeClient({ post });

    const result = await notifyAutoRotation(asNotifyClient(client), { from: null, to: candidate });
    expect(result).toBe(true);
    const arg = post.mock.calls[0][0] as { channel: string; text: string; blocks: unknown[] };
    expect(arg.text).toContain('none');
    expect(arg.text).toContain('B');
  });

  it('returns false (and logs warn) when chat.postMessage throws — rotation already committed', async () => {
    vi.mocked(getConfiguredUpdateChannel).mockReturnValue(fakeChannelId);
    vi.mocked(resolveChannel).mockResolvedValue(fakeChannelId);
    const post = vi.fn(async (_args: { channel: string; text: string; blocks: unknown[] }) => {
      throw new Error('rate_limited');
    });
    const client = makeClient({ post });

    const result = await notifyAutoRotation(asNotifyClient(client), { from: activeSummary, to: candidate });
    expect(result).toBe(false); // notify failed but caller already rotated; return value is informational only
  });

  it('renders "—" placeholder when active summary lacks usage stats', async () => {
    vi.mocked(getConfiguredUpdateChannel).mockReturnValue(fakeChannelId);
    vi.mocked(resolveChannel).mockResolvedValue(fakeChannelId);
    const post = vi.fn(async (_args: { channel: string; text: string; blocks: unknown[] }) => ({ ok: true }));
    const client = makeClient({ post });

    const fromWithoutUsage = { keyId: 'a', name: 'A' };
    await notifyAutoRotation(asNotifyClient(client), { from: fromWithoutUsage, to: candidate });
    const arg = post.mock.calls[0][0] as { blocks: unknown[] };
    const blockText = JSON.stringify(arg.blocks);
    expect(blockText).toContain('—');
  });
});
