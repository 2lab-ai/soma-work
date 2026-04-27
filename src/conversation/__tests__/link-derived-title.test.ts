/**
 * #762 — link-derived session title pipeline.
 *
 * Coverage targets:
 *   - 1-link branch (issue OR PR alone) → title = link.title (clamped, trimmed).
 *   - 2-link branch (issue + PR)        → Haiku 1-line summary; LLM null →
 *     deterministic `${issue} · ${pr}` join fallback.
 *   - generation guard: in-flight refresh aborts the title write when
 *     `linkRefreshGeneration` was bumped (e.g. resetSessionContext).
 *   - URL guard: aborts when the active URL set changed mid-flight.
 *   - Title stamping: writes link.title back via setSessionLink for slots
 *     that arrived without a title.
 *   - No-op when nothing useful resolved (no titles in any slot).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../link-metadata-fetcher', () => ({
  fetchBatchLinkMetadata: vi.fn(),
}));
vi.mock('../../conversation/dashboard', () => ({
  broadcastSingleSessionUpdate: vi.fn(),
}));
vi.mock('../summarizer', () => ({
  generateSessionSummaryTitle: vi.fn(),
}));

import { broadcastSingleSessionUpdate } from '../../conversation/dashboard';
import { fetchBatchLinkMetadata } from '../../link-metadata-fetcher';
import type { ConversationSession, SessionLink } from '../../types';
import {
  type LinkDerivedTitleHandler,
  stampLinkTitlesAndDeriveSessionTitle,
  summarizeIssueAndPrTitles,
} from '../link-derived-title';
import { generateSessionSummaryTitle } from '../summarizer';

const fetchMock = vi.mocked(fetchBatchLinkMetadata);
const broadcastMock = vi.mocked(broadcastSingleSessionUpdate);
const summarizeMock = vi.mocked(generateSessionSummaryTitle);

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U1',
    userId: 'U1',
    channelId: 'C1',
    threadTs: '1.0',
    isActive: true,
    lastActivity: new Date(),
    linkRefreshGeneration: 0,
    ...overrides,
  } as ConversationSession;
}

function makeHandler(session: ConversationSession): {
  handler: LinkDerivedTitleHandler;
  setLinkCalls: SessionLink[];
  setTitleCalls: string[];
  current: ConversationSession;
} {
  const setLinkCalls: SessionLink[] = [];
  const setTitleCalls: string[] = [];
  const ref = { current: session };
  const handler: LinkDerivedTitleHandler = {
    getSession: () => ref.current,
    getSessionByKey: () => ref.current,
    setSessionLink: (_c, _t, link) => {
      setLinkCalls.push(link);
      // Mirror what session-registry does: stamp into session.links by type.
      if (!ref.current.links) ref.current.links = {};
      const slot = link.type as 'issue' | 'pr' | 'doc';
      ref.current.links[slot] = { ...link };
    },
    setSessionTitle: (_c, _t, title) => {
      setTitleCalls.push(title);
      ref.current.title = title;
    },
  };
  return { handler, setLinkCalls, setTitleCalls, current: ref.current };
}

const ADDRESS = { channelId: 'C1', threadTs: '1.0', sessionKey: 'C1:1.0' };

describe('stampLinkTitlesAndDeriveSessionTitle', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    broadcastMock.mockReset();
    summarizeMock.mockReset();
  });

  it('1-link issue: stamps link.title and writes session.title', async () => {
    const session = makeSession({
      title: 'first message blob',
      links: {
        issue: { url: 'https://github.com/org/repo/issues/1', type: 'issue', provider: 'github' },
      },
    });
    const { handler, setLinkCalls, setTitleCalls } = makeHandler(session);

    fetchMock.mockResolvedValueOnce([
      {
        url: 'https://github.com/org/repo/issues/1',
        type: 'issue',
        provider: 'github',
        title: 'Fix login redirect bug',
        status: 'open',
      },
    ]);

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);

    expect(setLinkCalls).toHaveLength(1);
    expect(setLinkCalls[0].title).toBe('Fix login redirect bug');
    expect(setTitleCalls).toEqual(['Fix login redirect bug']);
    expect(broadcastMock).toHaveBeenCalledWith('C1:1.0');
    // Single-link branch must not invoke the LLM summarizer.
    expect(summarizeMock).not.toHaveBeenCalled();
  });

  it('1-link PR: stamps link.title and writes session.title', async () => {
    const session = makeSession({
      links: {
        pr: { url: 'https://github.com/org/repo/pull/42', type: 'pr', provider: 'github' },
      },
    });
    const { handler, setTitleCalls } = makeHandler(session);

    fetchMock.mockResolvedValueOnce([
      {
        url: 'https://github.com/org/repo/pull/42',
        type: 'pr',
        provider: 'github',
        title: 'Add OAuth2 callback handler',
        status: 'open',
      },
    ]);

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);
    expect(setTitleCalls).toEqual(['Add OAuth2 callback handler']);
  });

  it('2-link issue+PR: calls Haiku summarizer and writes its result', async () => {
    const session = makeSession({
      links: {
        issue: { url: 'https://github.com/org/repo/issues/1', type: 'issue', provider: 'github' },
        pr: { url: 'https://github.com/org/repo/pull/2', type: 'pr', provider: 'github' },
      },
    });
    const { handler, setTitleCalls } = makeHandler(session);

    fetchMock.mockResolvedValueOnce([
      {
        url: 'https://github.com/org/repo/issues/1',
        type: 'issue',
        provider: 'github',
        title: 'Fix login redirect bug',
      },
      {
        url: 'https://github.com/org/repo/pull/2',
        type: 'pr',
        provider: 'github',
        title: 'Add OAuth2 callback handler',
      },
    ]);
    summarizeMock.mockResolvedValueOnce({ title: 'Login redirect via OAuth2 callback', model: 'haiku' });

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(setTitleCalls).toEqual(['Login redirect via OAuth2 callback']);
  });

  it('2-link issue+PR: LLM null → deterministic `issue · pr` fallback', async () => {
    const session = makeSession({
      links: {
        issue: { url: 'https://github.com/org/repo/issues/1', type: 'issue', provider: 'github' },
        pr: { url: 'https://github.com/org/repo/pull/2', type: 'pr', provider: 'github' },
      },
    });
    const { handler, setTitleCalls } = makeHandler(session);

    fetchMock.mockResolvedValueOnce([
      {
        url: 'https://github.com/org/repo/issues/1',
        type: 'issue',
        provider: 'github',
        title: 'Fix login bug',
      },
      {
        url: 'https://github.com/org/repo/pull/2',
        type: 'pr',
        provider: 'github',
        title: 'Add OAuth2 handler',
      },
    ]);
    summarizeMock.mockResolvedValueOnce(null);

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);

    expect(setTitleCalls).toEqual(['Fix login bug · Add OAuth2 handler']);
  });

  it('aborts the title write when linkRefreshGeneration was bumped mid-flight', async () => {
    const session = makeSession({
      title: 'should-stay',
      links: { issue: { url: 'https://github.com/org/repo/issues/1', type: 'issue', provider: 'github' } },
    });
    const { handler, setTitleCalls } = makeHandler(session);

    // Resolve the fetch promise after we bump the generation, simulating a
    // resetSessionContext that fired while the network was in flight.
    fetchMock.mockImplementationOnce(async (links) => {
      // bump generation between the capture step and the write step
      session.linkRefreshGeneration = (session.linkRefreshGeneration ?? 0) + 1;
      return links.map((l) => ({ ...l, title: 'Stale title from old session' }));
    });

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);

    expect(setTitleCalls).toEqual([]);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('aborts the title write when active URL set changed mid-flight', async () => {
    const session = makeSession({
      links: { issue: { url: 'https://github.com/org/repo/issues/1', type: 'issue', provider: 'github' } },
    });
    const { handler, setTitleCalls } = makeHandler(session);

    fetchMock.mockImplementationOnce(async (links) => {
      // user attached a different issue mid-flight
      session.links!.issue = {
        url: 'https://github.com/org/repo/issues/999',
        type: 'issue',
        provider: 'github',
      };
      return links.map((l) => ({ ...l, title: 'Stale title' }));
    });

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);
    expect(setTitleCalls).toEqual([]);
  });

  it('does nothing when no slot has a fetched title', async () => {
    const session = makeSession({
      links: { pr: { url: 'https://github.com/org/repo/pull/1', type: 'pr', provider: 'github' } },
    });
    const { handler, setLinkCalls, setTitleCalls } = makeHandler(session);

    fetchMock.mockResolvedValueOnce([
      { url: 'https://github.com/org/repo/pull/1', type: 'pr', provider: 'github' /* no title */ },
    ]);

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);

    expect(setLinkCalls).toEqual([]);
    expect(setTitleCalls).toEqual([]);
  });

  it('skips fetch when all slots already carry titles, but still derives session.title', async () => {
    const session = makeSession({
      links: {
        issue: {
          url: 'https://github.com/org/repo/issues/1',
          type: 'issue',
          provider: 'github',
          title: 'Cached issue title',
        },
      },
    });
    const { handler, setTitleCalls } = makeHandler(session);

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setTitleCalls).toEqual(['Cached issue title']);
  });

  it('does not re-write session.title when it already matches the derived value', async () => {
    const session = makeSession({
      title: 'Cached issue title',
      links: {
        issue: {
          url: 'https://github.com/org/repo/issues/1',
          type: 'issue',
          provider: 'github',
          title: 'Cached issue title',
        },
      },
    });
    const { handler, setTitleCalls } = makeHandler(session);

    await stampLinkTitlesAndDeriveSessionTitle(handler, ADDRESS);

    expect(setTitleCalls).toEqual([]);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe('summarizeIssueAndPrTitles', () => {
  beforeEach(() => {
    summarizeMock.mockReset();
  });

  it('returns the LLM result when one is provided', async () => {
    summarizeMock.mockResolvedValueOnce({ title: 'concise headline', model: 'haiku' });
    const result = await summarizeIssueAndPrTitles('Issue X', 'PR Y');
    expect(result).toBe('concise headline');
  });

  it('falls back to `issue · pr` when LLM returns null', async () => {
    summarizeMock.mockResolvedValueOnce(null);
    const result = await summarizeIssueAndPrTitles('Fix login', 'Add OAuth2');
    expect(result).toBe('Fix login · Add OAuth2');
  });

  it('falls back to join when LLM throws', async () => {
    summarizeMock.mockRejectedValueOnce(new Error('boom'));
    const result = await summarizeIssueAndPrTitles('A', 'B');
    expect(result).toBe('A · B');
  });
});
