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
  function client(id: string, purpose: string, flags: { is_private?: boolean; is_archived?: boolean } = {}) {
    const channel = {
      id,
      name: 'workspace-fresh',
      purpose: { value: purpose },
      topic: { value: '' },
      is_member: true,
      ...flags,
    };
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

  it('the kept entry still takes the read’s fresh privacy and archive state (review P1)', async () => {
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}`, isPrivate: true });
    await registerChannel(client(id, '', { is_private: false, is_archived: true }), id);
    expect(getChannel(id)).toMatchObject({ repos: [repo], isPrivate: false, isArchived: true });
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

  it('a repo link removed on purpose inside the window is taken once the window ends (review P2)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    const unlinked = client(id, '');
    await scanChannels(unlinked);
    expect(getChannel(id)?.repos).toEqual([repo]);
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 2_000);
    expect(unlinked.conversations.info).toHaveBeenCalledTimes(1);
    expect(getChannel(id)?.repos).toEqual([]);
    expect(findChannelsForRepo(repo)).toEqual([]);
  });

  it('no re-read for a channel removed, or written again by the maker, before the window ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T01:00:00Z'));
    const a = fresh();
    upsertChannel({ id: a.id, name: 'workspace-fresh', purpose: `https://github.com/${a.repo}` });
    const ca = client(a.id, '');
    await registerChannel(ca, a.id);
    unregisterChannel(a.id);
    const b = fresh();
    upsertChannel({ id: b.id, name: 'workspace-fresh', purpose: `https://github.com/${b.repo}` });
    const cb = client(b.id, '');
    await registerChannel(cb, b.id);
    upsertChannel({ id: b.id, name: 'workspace-fresh', purpose: `https://github.com/${b.repo}` });
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 2_000);
    expect(ca.conversations.info).toHaveBeenCalledTimes(1);
    expect(cb.conversations.info).toHaveBeenCalledTimes(1);
    expect(getChannel(b.id)?.repos).toEqual([b.repo]);
  });

  // Review round 3 — the re-read is checked again when its answer arrives, and a failed one is retried.
  it('a re-read answered after the channel was removed, or written again, changes nothing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T02:00:00Z'));
    for (const meanwhile of ['remove', 'upsert'] as const) {
      const { id, repo } = fresh();
      upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
      const c = client(id, '');
      await registerChannel(c, id); // kept out → re-read scheduled
      let answer: (v: unknown) => void = () => undefined;
      const stale = { ok: true, channel: { id, name: 'stale', purpose: { value: 'https://github.com/acme/old' } } };
      c.conversations.info.mockImplementationOnce(() => new Promise((r) => (answer = r)));
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 2_000); // the re-read is in flight
      if (meanwhile === 'remove') unregisterChannel(id);
      else upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
      answer(stale);
      await vi.advanceTimersByTimeAsync(0);
      if (meanwhile === 'remove') expect(getChannel(id)).toBeUndefined();
      else expect(getChannel(id)?.repos).toEqual([repo]);
      expect(findChannelsForRepo('acme/old')).not.toContain(id);
    }
  });

  it('a re-read that fails is retried until one answers; the kept entry stays meanwhile', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T03:00:00Z'));
    const { id, repo } = fresh();
    upsertChannel({ id, name: 'workspace-fresh', purpose: `https://github.com/${repo}` });
    const c = client(id, '');
    await registerChannel(c, id);
    c.conversations.info.mockRejectedValueOnce(new Error('ratelimited'));
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 2_000);
    expect(getChannel(id)?.repos).toEqual([repo]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(c.conversations.info).toHaveBeenCalledTimes(3);
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
