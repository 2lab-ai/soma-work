/**
 * #970 — the production deps of the new repo channel read the real ChannelRegistry: a channel last seen archived
 * stays a candidate (flagged, tried last by ensureRepoChannel), so a restored channel is found again.
 */
import { describe, expect, it } from 'vitest';
import { markChannelArchived, upsertChannel } from '../../channel-registry';
import { repoChannelDeps } from '../new-task-provider';

describe('repoChannelDeps.mappedChannels (#970)', () => {
  it('keeps a channel marked archived, flagged — never silently drops it', () => {
    const n = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const repo = `acme/prov970-${n}`;
    upsertChannel({ id: `C_LIVE_${n}`, name: 'live', purpose: `https://github.com/${repo}` });
    upsertChannel({ id: `C_ARCH_${n}`, name: 'old', purpose: `https://github.com/${repo}`, isPrivate: true });
    markChannelArchived(`C_ARCH_${n}`);
    const mapped = repoChannelDeps({} as never).mappedChannels(repo);
    expect(mapped).toEqual(
      expect.arrayContaining([
        { id: `C_LIVE_${n}`, name: 'live', isPrivate: false },
        { id: `C_ARCH_${n}`, name: 'old', isPrivate: true, isArchived: true },
      ]),
    );
    expect(mapped).toHaveLength(2);
  });
});
