import { describe, expect, it, vi } from 'vitest';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * #1031 ⑤ — the thread header of a SLEEPING session says it sleeps.
 *
 * The surface reads the session's lifecycle state on every render, so the
 * re-render the sleep transition asks for (and the next one after a wake)
 * paints the right badge. Before: "⚪ 사용 가능 · 사용자 액션 대기" under a 💤.
 */

const KEY = 'C1:1700.000000';

function makeSession(over: Partial<ConversationSession> = {}): ConversationSession {
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: '1700.000000',
    threadRootTs: '1700.000000',
    threadModel: 'user-initiated',
    ownerId: 'U1',
    ownerName: 'zhuge',
    title: 'sleepy',
    isActive: true,
    terminated: false,
    activityState: 'idle',
    actionPanel: {
      channelId: 'C1',
      messageTs: 'panel-ts',
      agentPhase: '사용자 액션 대기',
      lastProgressAt: 1_700_000_000_000,
    },
    ...over,
  } as ConversationSession;
}

function makeDeps(session: ConversationSession) {
  const updates: Array<{ text: string; blocks: any[] }> = [];
  const slackApi = {
    getClient: vi.fn().mockReturnValue({}),
    getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
    updateMessage: vi.fn(async (_channel: string, _ts: string, text: string, blocks: any[]) => {
      updates.push({ text, blocks });
    }),
    postMessage: vi.fn(async () => ({ ts: 'posted-ts' })),
  };
  const deps: ThreadSurfaceDeps = {
    slackApi: slackApi as any,
    claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(session) } as any,
    requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
    todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
  };
  return { deps, updates };
}

function rendered(updates: Array<{ blocks: any[] }>): string {
  return JSON.stringify(updates.at(-1)?.blocks ?? []);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ThreadSurface — Sleep header (#1031 ⑤)', () => {
  it('renders 💤 Sleep for a SLEEPING session', async () => {
    const session = makeSession({ state: 'SLEEPING' });
    const { deps, updates } = makeDeps(session);

    await new ThreadSurface(deps).refreshAndRender(session, KEY);
    await settle();

    const out = rendered(updates);
    expect(out).toContain('💤 *Sleep* · 메시지를 보내면 이어서 진행');
    expect(out).not.toContain('사용 가능');
  });

  it('renders the awake badge again once the session is MAIN', async () => {
    const session = makeSession({ state: 'MAIN' });
    const { deps, updates } = makeDeps(session);

    await new ThreadSurface(deps).refreshAndRender(session, KEY);
    await settle();

    const out = rendered(updates);
    expect(out).not.toContain('Sleep');
    expect(out).toContain('사용자 액션 대기');
  });
});
