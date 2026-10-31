import { describe, expect, it, vi } from 'vitest';
import { EventRouter, type EventRouterDeps } from '../event-router';

/**
 * E2 ⑧ — a live task's instruction thread is protected (.prd/18 D2 (2)).
 * The router asks the host's guard before a mention or a mentioned file
 * upload could open a Slack run there; a `/z` command ZRouter finishes on the
 * spot (no run) still goes through. What the guard answers is the host's.
 */

type EventListener = (args: { event: any; say: any }) => Promise<void>;

function harness(guard?: EventRouterDeps['guardInstructionThread']) {
  const events = new Map<string, EventListener>();
  const app = {
    message: vi.fn(),
    event: vi.fn((name: string, listener: EventListener) => void events.set(name, listener)),
    command: vi.fn(),
  } as any;
  const messageHandler = vi.fn(async () => {});
  const deps = {
    slackApi: {
      getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
      getClient: vi.fn(() => ({})),
      addReaction: vi.fn().mockResolvedValue(undefined),
    } as any,
    claudeHandler: {
      getSession: vi.fn(() => undefined),
      findSessionBySourceThread: vi.fn(),
      setExpiryCallbacks: vi.fn(),
      cleanupInactiveSessions: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
    } as any,
    sessionManager: {} as any,
    actionHandlers: { registerHandlers: vi.fn() },
    ...(guard ? { guardInstructionThread: guard } : {}),
  } as EventRouterDeps;
  const router = new EventRouter(app, deps, messageHandler) as any;
  router.setupMessageHandlers();
  const mention = events.get('app_mention')!;
  const base = { user: 'U1', channel: 'C1', ts: '1700.000200', thread_ts: '1700.000100', team: 'T1' };
  return {
    router,
    messageHandler,
    mention: (over: Record<string, unknown>) =>
      mention({ event: { type: 'app_mention', ...base, ...over }, say: vi.fn() }),
    upload: (over: Record<string, unknown>) =>
      router.handleFileUpload(
        { type: 'message', subtype: 'file_share', ...base, files: [{ id: 'F1' }], ...over },
        vi.fn(),
      ),
  };
}

describe('app_mention — a task’s instruction thread (E2 ⑧)', () => {
  it('a mention the guard answers opens no Slack run', async () => {
    const guard = vi.fn(async () => true);
    const h = harness(guard);
    await h.mention({ text: '<@U_BOT> 이것도 해줘' });
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', ts: '1700.000200' }),
      expect.any(Function),
    );
    expect(h.messageHandler).not.toHaveBeenCalled();
  });

  it('a thread the guard does not claim runs as before', async () => {
    const h = harness(vi.fn(async () => false));
    await h.mention({ text: '<@U_BOT> 이것도 해줘' });
    expect(h.messageHandler).toHaveBeenCalledTimes(1);
  });

  it('`!`, `%` and a `/z` continuation are guarded too', async () => {
    for (const text of ['<@U_BOT> !멈춰', '<@U_BOT> %model opus']) {
      const guard = vi.fn(async () => true);
      const h = harness(guard);
      await h.mention({ text });
      expect(h.messageHandler).not.toHaveBeenCalled();
    }
    const guard = vi.fn(async () => true);
    const h = harness(guard);
    h.router.zRouter = { dispatch: vi.fn().mockResolvedValue({ handled: true, continueWithPrompt: '새 작업' }) };
    await h.mention({ text: '<@U_BOT> /z new 새 작업' });
    expect(guard).toHaveBeenCalled();
    expect(h.messageHandler).not.toHaveBeenCalled();
  });

  it('a `/z` command ZRouter finishes on the spot (no run) is not guarded', async () => {
    const guard = vi.fn(async () => true);
    const h = harness(guard);
    const dispatch = vi.fn().mockResolvedValue({ handled: true, consumed: true });
    h.router.zRouter = { dispatch };
    await h.mention({ text: '<@U_BOT> /z persona' });
    expect(dispatch).toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  it('no guard wired: today’s behavior', async () => {
    const h = harness();
    await h.mention({ text: '<@U_BOT> 이것도 해줘' });
    expect(h.messageHandler).toHaveBeenCalledTimes(1);
  });
});

describe('file_share — a mentioned upload in a task’s instruction thread (E2 ⑧)', () => {
  it('the guard answers it: no new Slack session', async () => {
    const guard = vi.fn(async () => true);
    const h = harness(guard);
    await h.upload({ text: '<@U_BOT> 이 파일도 봐줘' });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ files: [{ id: 'F1' }] }), expect.any(Function));
    expect(h.messageHandler).not.toHaveBeenCalled();
  });

  it('a thread the guard does not claim starts a session as before', async () => {
    const h = harness(vi.fn(async () => false));
    await h.upload({ text: '<@U_BOT> 이 파일 봐줘' });
    expect(h.messageHandler).toHaveBeenCalledTimes(1);
  });
});
