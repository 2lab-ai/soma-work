import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConversationSession,
  setThreadSurfaceProviders,
  ThreadSurface,
  type ThreadSurfaceDeps,
} from '../thread-surface';

/**
 * T2 end to end — the composed surface message (2026-10-27, trinity-reviewed):
 *
 *   title → status rail → identity/links → controls
 *
 * with 종료됨 stated once, and one live PR state shared by the rail chip and
 * the link row — used only while it still describes the session's active PR
 * link (same URL; link not re-recorded with another state since the fetch).
 */

const KEY = 'C1:1700.000000';
const PR = 'https://github.com/acme/app/pull/664';
const OTHER = 'https://github.com/acme/app/pull/700';

afterEach(() => {
  setThreadSurfaceProviders({
    getSessionTheme: () => 'default',
    fetchGitHubPRDetails: async () => undefined,
    fetchGitHubPRReviewStatus: async () => undefined,
    isPRMergeable: () => false,
  });
});

function prLink(url: string, status?: string) {
  return { url, type: 'pr', provider: 'github', label: url === PR ? 'PR #664' : 'PR #700', status };
}

function makeSession(over: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: '1700.000000',
    threadRootTs: '1700.000000',
    threadModel: 'bot-initiated',
    ownerId: 'U1',
    ownerName: 'Z',
    title: 'PR #664 Review',
    workflow: 'pr-review',
    links: { pr: prLink(PR, 'open') },
    linkHistory: { prs: [prLink(PR, 'open')] },
    isActive: true,
    terminated: false,
    activityState: 'idle',
    actionPanel: { channelId: 'C1', messageTs: '1700.000000', agentPhase: '사용자 액션 대기', turnSummary: '⏱ 0:09' },
    ...over,
  } as ConversationSession;
}

function harness(session: ConversationSession) {
  const updates: any[][] = [];
  const deps: ThreadSurfaceDeps = {
    slackApi: {
      getClient: vi.fn().mockReturnValue({}),
      getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
      updateMessage: vi.fn(async (_c: string, _ts: string, _t: string, blocks: any[]) => {
        updates.push(blocks);
      }),
      postMessage: vi.fn(async () => ({ ts: 'posted-ts' })),
    } as any,
    claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(session) } as any,
    requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
    todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
  };
  return { surface: new ThreadSurface(deps), updates };
}

function mergedPrProvider() {
  setThreadSurfaceProviders({
    fetchGitHubPRDetails: async () => ({
      state: 'closed',
      merged: true,
      mergeable: false,
      mergeableState: 'unknown',
      draft: false,
      head: 'feat/x',
      base: 'main',
    }),
    fetchGitHubPRReviewStatus: async () => 'approved',
    isPRMergeable: () => false,
  });
}

const text = (blocks: any[]) => JSON.stringify(blocks);

describe('ThreadSurface — T2 composed layout', () => {
  it('orders title → rail → header rows → controls, with no fields grid', async () => {
    mergedPrProvider();
    const session = makeSession();
    const { surface, updates } = harness(session);

    await surface.refreshAndRender(session, KEY);
    await surface.updatePanel(session, KEY);
    const blocks = updates.at(-1)!;

    expect(blocks[0].type).toBe('header');
    expect(blocks[1].type).toBe('section');
    expect(blocks[1].text.text.startsWith('⚪ *사용 가능* · 사용자 액션 대기')).toBe(true);
    expect(blocks[1].text.text).toContain('🔀 Merged');
    expect(blocks.at(-1).type).toBe('actions');
    expect(blocks.some((b: any) => Array.isArray(b.fields))).toBe(false);
    expect(blocks.some((b: any) => b.type === 'divider')).toBe(false);
  });

  it('shows one current PR state: live word first, the recorded one in parentheses', async () => {
    mergedPrProvider();
    const session = makeSession();
    const { surface, updates } = harness(session);

    await surface.refreshAndRender(session, KEY);
    await surface.updatePanel(session, KEY);
    const all = text(updates.at(-1)!);

    expect(all).toContain('· Merged (기록 당시 Open)');
    expect(all).not.toMatch(/🟢|🟣|🔴/);
  });

  it('never labels the active PR with a status fetched for another URL', async () => {
    mergedPrProvider();
    const session = makeSession({
      links: { pr: prLink(OTHER, 'open') },
      linkHistory: { prs: [prLink(OTHER, 'open')] },
    });
    const { surface, updates } = harness(session);
    await surface.refreshAndRender(session, KEY); // cache: merged, fetched for OTHER

    // The active PR switches within the cache TTL; the provider now fails.
    setThreadSurfaceProviders({ fetchGitHubPRDetails: async () => undefined });
    session.links = { pr: prLink(PR, 'open') };
    session.linkHistory = { prs: [prLink(OTHER, 'open'), prLink(PR, 'open')] };
    await surface.updatePanel(session, KEY);
    const blocks = updates.at(-1)!;

    expect(blocks[1].text.text).not.toContain('🔀');
    expect(text(blocks)).toContain(`<${PR}|PR #664> · 기록 당시 Open`);
  });

  it('drops a cached status once the link is re-recorded with another state', async () => {
    mergedPrProvider();
    const session = makeSession();
    const { surface, updates } = harness(session);
    await surface.refreshAndRender(session, KEY); // cache: merged, link stored 'open'

    // Re-recorded as 'draft' within the TTL; the provider now fails.
    setThreadSurfaceProviders({ fetchGitHubPRDetails: async () => undefined });
    session.links = { pr: prLink(PR, 'draft') };
    session.linkHistory = { prs: [prLink(PR, 'draft')] };
    await surface.updatePanel(session, KEY);
    const all = text(updates.at(-1)!);

    expect(all).not.toContain('Merged');
    expect(all).toContain('· 기록 당시 Draft');
  });

  it('states 종료됨 exactly once on the closed surface', async () => {
    mergedPrProvider();
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      setThreadSurfaceProviders({ getSessionTheme: () => theme });
      const session = makeSession();
      const { surface, updates } = harness(session);
      await surface.refreshAndRender(session, KEY);
      session.isActive = false;
      await surface.close(session, KEY);
      const blocks = updates.at(-1)!;

      expect(text(blocks).match(/종료됨/g)).toHaveLength(1);
      expect(text(blocks)).not.toContain('🔴');
      expect(blocks.some((b: any) => b.type === 'actions')).toBe(false);
    }
  });
});
