import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionLink } from '../types';

// Mock external dependencies before importing the module under test
vi.mock('../config', () => ({
  config: { github: { token: 'fake-token' } },
}));
vi.mock('../github-auth', () => ({
  getGitHubAppAuth: () => null,
}));
vi.mock('../logger', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
    debug() {}
  },
}));

import { fetchBatchLinkMetadata, fetchLinkMetadata } from '../link-metadata-fetcher';

// We mock fetchLinkMetadata at module level for the batch tests
vi.mock('../link-metadata-fetcher', async (importOriginal) => {
  const original = await importOriginal<typeof import('../link-metadata-fetcher')>();
  return {
    ...original,
    // Keep fetchBatchLinkMetadata as-is; it internally calls fetchLinkMetadata
    // which we'll mock via global fetch
  };
});

describe('fetchBatchLinkMetadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array for empty input', async () => {
    const result = await fetchBatchLinkMetadata([]);
    expect(result).toEqual([]);
  });

  it('returns enriched links with title/status', async () => {
    // Mock global fetch to return metadata for GitHub PRs
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'Fix bug', state: 'open', draft: false }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const links: SessionLink[] = [
      {
        url: 'https://github.com/org/repo/pull/1',
        type: 'pr',
        provider: 'github',
      },
      {
        url: 'https://github.com/org/repo/pull/2',
        type: 'pr',
        provider: 'github',
      },
    ];

    const result = await fetchBatchLinkMetadata(links);

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Fix bug');
    expect(result[0].status).toBe('open');
    expect(result[1].title).toBe('Fix bug');
  });

  it('preserves full title past the legacy 40-char cap (#762)', async () => {
    // Pre-#762 the fetcher truncated to 40 chars. #762 stores the real title
    // (subject to a defensive 500-char ceiling — see MAX_CACHED_TITLE_LENGTH)
    // so the dashboard ref-pill hover tooltip and the LLM summarizer see real
    // input.
    const longTitle = `A really long PR title that definitely exceeds the old 40-character cap ${'–'.repeat(50)}`;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: longTitle, state: 'open', draft: false }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const link: SessionLink = {
      url: 'https://github.com/org/repo/pull/999',
      type: 'pr',
      provider: 'github',
    };

    const result = await fetchLinkMetadata(link);
    expect(result.title).toBe(longTitle);
    expect(result.title?.length).toBeGreaterThan(40);
  });

  it('caps stored title at MAX_CACHED_TITLE_LENGTH to prevent unbounded memory (#762)', async () => {
    // GitHub/Jira real titles cap around 256, so 500 chars is "any real title
    // wins"; only pathological payloads get clipped.
    const pathological = 'A'.repeat(2000);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: pathological, state: 'open', draft: false }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchLinkMetadata({
      url: 'https://github.com/org/repo/pull/2000',
      type: 'pr',
      provider: 'github',
    });
    expect(result.title?.length).toBe(500);
  });

  it('one link failure does not block others', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) {
        // First call succeeds
        return {
          ok: true,
          json: async () => ({ title: 'Good PR', state: 'open', draft: false }),
        };
      }
      // Second call fails
      throw new Error('Network error');
    });
    vi.stubGlobal('fetch', mockFetch);

    const links: SessionLink[] = [
      {
        url: 'https://github.com/org/repo/pull/10',
        type: 'pr',
        provider: 'github',
        label: 'PR #10',
      },
      {
        url: 'https://github.com/org/repo/pull/20',
        type: 'pr',
        provider: 'github',
        label: 'PR #20',
      },
    ];

    const result = await fetchBatchLinkMetadata(links);

    // Both should return (one enriched, one fallback)
    expect(result).toHaveLength(2);
    // First link should have enriched title
    expect(result[0].title).toBe('Good PR');
    // Second link should still be present (graceful fallback)
    expect(result[1].url).toBe('https://github.com/org/repo/pull/20');
  });
});
