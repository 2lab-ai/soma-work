import { describe, expect, it } from 'vitest';
import { checkRepoChannelMatch, findChannelsForRepo, getChannel, upsertChannel } from '../channel-registry';

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
