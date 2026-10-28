import { afterEach, describe, expect, it, vi } from 'vitest';
import { setThreadHeaderProviders } from '../thread-header-builder';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * The bot-thread root IS the surface message (spec 10-agent-inbox-board §3.4-1):
 * it is posted before its own thread ts — and so its session key — exists, and
 * gets the `📋 작업 로그` link on the surface's re-render, which must address
 * the header with the session key it renders for.
 */

const KEY = 'work:C1:1700.000000';
const URL = 'https://soma.example/dashboard/U1?session=work%3AC1%3A1700.000000';
const LINK = `📋 <${URL}|작업 로그>`;

afterEach(() => {
  setThreadHeaderProviders({ getDashboardSessionUrl: () => undefined });
});

function makeSession(over: Partial<ConversationSession> = {}): ConversationSession {
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: '1700.000000',
    threadRootTs: '1700.000000',
    threadModel: 'bot-initiated',
    ownerId: 'U1',
    ownerName: 'zhuge',
    title: 'dashboard link demo',
    workflow: 'default',
    model: 'claude-opus-4-6-20250414',
    linkHistory: { prs: [{ url: 'https://github.com/o/r/pull/1', label: 'PR #1', provider: 'github' }] },
    isActive: true,
    terminated: false,
    logVerbosity: 0,
    activityState: 'working',
    actionPanel: { channelId: 'C1', messageTs: '1700.000000' },
    ...over,
  } as ConversationSession;
}

function render(session: ConversationSession) {
  const updates: Array<{ ts: string; blocks: any[] }> = [];
  const deps: ThreadSurfaceDeps = {
    slackApi: {
      getClient: vi.fn().mockReturnValue({}),
      getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
      updateMessage: vi.fn(async (_channel: string, ts: string, _text: string, blocks: any[]) => {
        updates.push({ ts, blocks });
      }),
      postMessage: vi.fn(async () => ({ ts: 'posted-ts' })),
    } as any,
    claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(session) } as any,
    requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
    todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
  };
  return { surface: new ThreadSurface(deps), updates };
}

function indexOfText(blocks: any[], text: string): number {
  return blocks.findIndex((block) => JSON.stringify(block ?? {}).includes(text));
}

describe('ThreadSurface — header dashboard link', () => {
  it('re-renders the bot-thread root with the 📋 작업 로그 link for its own session key', async () => {
    const provider = vi.fn().mockReturnValue(URL);
    setThreadHeaderProviders({ getDashboardSessionUrl: provider });
    const session = makeSession();
    const { surface, updates } = render(session);

    await surface.updatePanel(session, KEY);

    const root = updates.filter((u) => u.ts === '1700.000000').at(-1);
    expect(root).toBeDefined();
    const at = indexOfText(root!.blocks, LINK);
    expect(at).toBeGreaterThanOrEqual(0);
    // Inside the header chrome, ahead of the control rows.
    const controls = root!.blocks.findIndex((block) => block?.type === 'divider' || block?.type === 'actions');
    expect(at).toBeLessThan(controls);
    expect(controls).toBeLessThanOrEqual(4);
    expect(provider).toHaveBeenCalledWith('U1', KEY);
  });

  it('keeps the link on the closed surface', async () => {
    setThreadHeaderProviders({ getDashboardSessionUrl: () => URL });
    const session = makeSession({ isActive: false });
    const { surface, updates } = render(session);

    await surface.updatePanel(session, KEY);

    const root = updates.filter((u) => u.ts === '1700.000000').at(-1);
    expect(indexOfText(root?.blocks ?? [], LINK)).toBeGreaterThanOrEqual(0);
  });
});
