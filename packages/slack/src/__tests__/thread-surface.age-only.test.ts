import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * The thread header says `마지막 활동 <date token>`. Slack draws the token's
 * `{ago}` when the thread is viewed, so a header whose ONLY change is a newer
 * progress stamp tells the reader almost nothing new — yet the token's epoch
 * changed the rendered blocks, the dedupe never hit, and every progress signal
 * of a working turn cost a `chat.update`. On a busy host that was 1,345 of the
 * 2,575 Slack calls of a 23-minute window, all through one serial lane that
 * every session's rendering (and therefore every turn's end) waited behind.
 *
 * So an edit that only moves the progress/liveness ages waits until a minute
 * after the last edit (and is then made, so the header never freezes); any
 * other change — the step, the tool, a question, the badge — is drawn at once.
 */

const KEY = 'C1:1700.000000';
const T0 = 1_700_000_000_000;

function makeSession(): ConversationSession {
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: '1700.000000',
    threadRootTs: '1700.000000',
    threadModel: 'user-initiated',
    ownerId: 'U1',
    ownerName: 'zhuge',
    title: 'works',
    isActive: true,
    terminated: false,
    activityState: 'working',
    actionPanel: { channelId: 'C1', messageTs: 'panel-ts', agentPhase: '코드 수정 중' },
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
    requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(true) } as any,
    todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
  };
  return { deps, updates };
}

function token(atMs: number): string {
  const sec = Math.floor(atMs / 1000);
  return `<!date^${sec}^{ago}|${new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}>`;
}

const last = (updates: Array<{ blocks: any[] }>) => JSON.stringify(updates.at(-1)?.blocks ?? []);

describe('ThreadSurface — an edit that only moves the ages waits a minute', () => {
  let session: ConversationSession;
  let surface: ThreadSurface;
  let updates: Array<{ text: string; blocks: any[] }>;

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0 });
    session = makeSession();
    const made = makeDeps(session);
    updates = made.updates;
    surface = new ThreadSurface(made.deps);
    await surface.setStatus(session, KEY, { lastProgressAt: T0 });
    expect(updates).toHaveLength(1);
  });

  afterEach(() => {
    surface.dispose();
    vi.useRealTimers();
  });

  it('a newer progress stamp alone does not edit the header within the minute', async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    await surface.setStatus(session, KEY, { lastProgressAt: T0 + 5_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await surface.setStatus(session, KEY, { lastProgressAt: T0 + 15_000 });

    expect(updates).toHaveLength(1);
  });

  it('the held age edit is made a minute after the last edit, with the newest stamp', async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    await surface.setStatus(session, KEY, { lastProgressAt: T0 + 5_000 });
    expect(updates).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(updates).toHaveLength(2);
    expect(last(updates)).toContain(token(T0 + 5_000));
  });

  it('a new step or tool is drawn at once, ages and all', async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    await surface.setStatus(session, KEY, { activeTool: 'Bash', lastProgressAt: T0 + 5_000 });

    expect(updates).toHaveLength(2);
    expect(last(updates)).toContain('Bash');
    expect(last(updates)).toContain(token(T0 + 5_000));
  });

  it('a question is drawn at once', async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    await surface.setStatus(session, KEY, { waitingForChoice: true, lastProgressAt: T0 + 5_000 });

    expect(updates).toHaveLength(2);
  });

  it('a wait that starts in the same second as the progress is drawn at once', async () => {
    // A waiting header shows two dates: since when it waits, and the last progress. When both move in the same
    // second they cannot be told apart, and the wait's start is content — so the edit is drawn.
    session.activityState = 'waiting';
    session.activityStateChangedAt = T0 + 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await surface.setStatus(session, KEY, { waitingForChoice: true, lastProgressAt: T0 + 5_000 });
    expect(updates).toHaveLength(2);

    session.activityStateChangedAt = T0 + 15_000;
    await vi.advanceTimersByTimeAsync(10_000);
    await surface.setStatus(session, KEY, { lastProgressAt: T0 + 15_000 });

    expect(updates).toHaveLength(3);
    expect(last(updates)).toContain(`${token(T0 + 15_000)}부터 기다림`);
  });

  it('a badge change is drawn at once', async () => {
    session.activityState = 'idle';
    await vi.advanceTimersByTimeAsync(5_000);
    await surface.setStatus(session, KEY, { lastProgressAt: T0 + 5_000 });

    expect(updates).toHaveLength(2);
  });

  it('an age edit after the minute is made at once', async () => {
    await vi.advanceTimersByTimeAsync(61_000);
    await surface.setStatus(session, KEY, { lastProgressAt: T0 + 61_000 });

    expect(updates).toHaveLength(2);
    expect(last(updates)).toContain(token(T0 + 61_000));
  });
});
