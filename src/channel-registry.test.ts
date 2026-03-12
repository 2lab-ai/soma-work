import { describe, expect, it } from 'vitest';
import { checkRepoChannelMatch } from './channel-registry';

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
