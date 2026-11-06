import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkRepoChannelMatch,
  findChannelsForRepo,
  getChannel,
  markChannelArchived,
  registerChannel,
  scanChannels,
  unregisterChannel,
  upsertChannel,
} from '../channel-registry';

describe('checkRepoChannelMatch', () => {
  it('returns no_repo for non-GitHub URLs', () => {
    const result = checkRepoChannelMatch('not-a-github-url', 'C123');

    expect(result.correct).toBe(true);
    expect(result.reason).toBe('no_repo');
    expect(result.suggestedChannels).toEqual([]);
  });

  it('returns no_mapping when repo has no mapped channels', () => {
    const uniqueRepo = `acme/no-map-${Date.now()}`;
    const result = checkRepoChannelMatch(`https://github.com/${uniqueRepo}/pull/1`, 'C123');

    expect(result.correct).toBe(false);
    expect(result.reason).toBe('no_mapping');
    expect(result.suggestedChannels).toEqual([]);
  });
});

// 2026-11-05 — a channel the bot has just made and described is learned from those values (no read back).
describe('upsertChannel', () => {
  it('maps the channel to the repo in its purpose at once', () => {
    const id = `C_UP_${Date.now()}`;
    const repo = `acme/fresh-${Date.now()}`;
    const info = upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    expect(info.repos).toEqual([repo]);
    expect(getChannel(id)?.name).toBe('workspace-fresh');
    expect(findChannelsForRepo(repo)).toEqual([id]);
    expect(checkRepoChannelMatch(`https://github.com/${repo}/pull/1`, id)).toMatchObject({
      correct: true,
      reason: 'matched',
    });
    expect(getChannel(id)).toMatchObject({ isPrivate: false, isArchived: false });
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}`, isPrivate: true });
    expect(getChannel(id)?.isPrivate).toBe(true);
  });
});

// #970 — a read that lands right after the maker described a channel must not erase its repo mapping; a real
// rejoin (after a removal) and a later description change still register what they read.
describe('the maker’s entry against a stale read (#970)', () => {
  /** A Slack client whose conversations.info / list answer with this channel, purpose as given. */
  function client(id: string, purpose: string) {
    const channel = { id, name: 'workspace-fresh', purpose: { value: purpose }, topic: { value: '' }, is_member: true };
    return {
      conversations: {
        info: vi.fn(async () => ({ ok: true, channel })),
        list: vi.fn(async () => ({ ok: true, channels: [channel], response_metadata: {} })),
      },
    } as any;
  }
  const fresh = () => {
    const n = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    return { id: `C_970_${n}`, repo: `acme/r970-${n}` };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a registration read with no repo, right after the maker’s upsert, keeps the mapping', async () => {
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    await registerChannel(client(id, ''), id);
    expect(getChannel(id)?.repos).toEqual([repo]);
    expect(findChannelsForRepo(repo)).toEqual([id]);
  });

  it('a startup scan read with no repo, right after the maker’s upsert, keeps the mapping too', async () => {
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    await scanChannels(client(id, ''));
    expect(getChannel(id)?.repos).toEqual([repo]);
  });

  it('after a removal, a rejoin registers what it reads', async () => {
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    unregisterChannel(id);
    await registerChannel(client(id, ''), id);
    expect(getChannel(id)?.repos).toEqual([]);
    expect(findChannelsForRepo(repo)).toEqual([]);
  });

  it('once the maker’s window has passed, a read replaces the entry (the description really changed)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    vi.setSystemTime(new Date('2026-11-06T00:03:00Z'));
    await registerChannel(client(id, ''), id);
    expect(getChannel(id)?.repos).toEqual([]);
  });

  it('a read that names a repo is always taken', async () => {
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    await registerChannel(client(id, `https://github.com/${repo}-renamed`), id);
    expect(getChannel(id)?.repos).toEqual([`${repo}-renamed`]);
  });

  it('markChannelArchived marks a known channel archived (and nothing else)', () => {
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    markChannelArchived(id);
    expect(getChannel(id)?.isArchived).toBe(true);
    expect(() => markChannelArchived('C_UNKNOWN_970')).not.toThrow();
  });
});
