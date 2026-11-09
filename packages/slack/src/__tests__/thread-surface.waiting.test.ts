import { describe, expect, it, vi } from 'vitest';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * #1072 — the thread header of a session waiting on its user says since when.
 *
 * The surface hands the builder the stamp of the session's switch to `waiting`
 * (the registry's `activityStateChangedAt`, saved and restored across a
 * restart). Only a waiting session hands one over: a working session's stamp
 * is when it started working, never a wait.
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
    title: 'asks',
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

function token(atMs: number): string {
  const sec = Math.floor(atMs / 1000);
  return `<!date^${sec}^{ago}|${new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}>`;
}

const ASKED = 1_700_000_000_000 - 12 * 60_000;

describe('ThreadSurface — the wait in the header (#1072)', () => {
  it('a session waiting on its question shows "<token>부터 기다림" from its waiting stamp', async () => {
    const session = makeSession({
      activityState: 'waiting',
      activityStateChangedAt: ASKED,
      actionPanel: { channelId: 'C1', messageTs: 'panel-ts', waitingForChoice: true, lastProgressAt: ASKED },
    });
    const { deps, updates } = makeDeps(session);

    await new ThreadSurface(deps).refreshAndRender(session, KEY);
    await settle();

    expect(rendered(updates)).toContain(`${token(ASKED)}부터 기다림`);
  });

  it('a working session never shows a wait, even with its stamp set', async () => {
    const session = makeSession({
      activityState: 'working',
      activityStateChangedAt: ASKED,
      actionPanel: { channelId: 'C1', messageTs: 'panel-ts', waitingForChoice: true, lastProgressAt: ASKED },
    });
    const { deps, updates } = makeDeps(session);

    await new ThreadSurface(deps).refreshAndRender(session, KEY);
    await settle();

    expect(rendered(updates)).not.toContain('부터 기다림');
  });
});
