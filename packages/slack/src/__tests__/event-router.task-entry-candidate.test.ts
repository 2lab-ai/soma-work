import { describe, expect, it, vi } from 'vitest';
import { EventRouter, type EventRouterDeps, isTaskEntryCandidate } from '../event-router';

/**
 * E2 ⑦ — the router marks a plain instruction candidate on the ORIGINAL
 * app_mention (.prd/18 D2 (1)): `routeContext.taskEntryCandidate`. Nothing
 * reads it until ⑧; here only the marking is pinned.
 *
 * A candidate is a plain mention with words. Not a candidate: a file mention
 * (the file_share path takes it), an incident (the ingress takes it), `/z`
 * (continuation included), text ZRouter rewrote, a `/` or `%` command, a `!`
 * steer, `new <text>`, a synthetic event, a DM, a bare mention.
 */

type EventListener = (args: { event: any; say: any }) => Promise<void>;

function harness() {
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
      getSession: vi.fn(),
      findSessionBySourceThread: vi.fn(),
      setExpiryCallbacks: vi.fn(),
      cleanupInactiveSessions: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
    } as any,
    sessionManager: {} as any,
    actionHandlers: { registerHandlers: vi.fn() },
  } as EventRouterDeps;
  const router = new EventRouter(app, deps, messageHandler);
  (router as any).setupMessageHandlers();
  const mention = events.get('app_mention');
  if (!mention) throw new Error('no app_mention listener');
  const fire = (over: Record<string, unknown>) =>
    mention({
      event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1700.000100', team: 'T1', ...over },
      say: vi.fn(),
    });
  const forwarded = () => (messageHandler.mock.calls[0] as any[] | undefined)?.[0];
  return { router: router as any, messageHandler, fire, forwarded };
}

describe('app_mention — the task entry candidate marker (E2 ⑦)', () => {
  it('a plain mention with words is a candidate — in a channel or in a thread', async () => {
    const top = harness();
    await top.fire({ text: '<@U_BOT> 로그인 버그 고쳐줘' });
    expect(top.forwarded().routeContext).toEqual({ taskEntryCandidate: true });

    const inThread = harness();
    await inThread.fire({ text: '<@U_BOT> 이것도 봐줘', thread_ts: '1700.000001' });
    expect(inThread.forwarded().routeContext?.taskEntryCandidate).toBe(true);
  });

  it('another mention in the text is kept, and does not change the verdict', async () => {
    const h = harness();
    await h.fire({ text: '<@U_BOT> <@U2> 랑 같이 봐줘' });
    expect(h.forwarded().text).toBe('<@U2> 랑 같이 봐줘');
    expect(h.forwarded().routeContext?.taskEntryCandidate).toBe(true);
  });

  it.each([
    ['a `!` steer', '<@U_BOT> !지금 멈추고 이거 해'],
    ['`new <text>`', '<@U_BOT> new 새 작업'],
    ['a `/` command', '<@U_BOT> /compact'],
    ['a `%` command', '<@U_BOT> %model opus'],
    ['a bare mention', '<@U_BOT>'],
  ])('%s is not a candidate', async (_label, text) => {
    const h = harness();
    await h.fire({ text });
    expect(h.messageHandler).toHaveBeenCalledTimes(1);
    expect(h.forwarded().routeContext?.taskEntryCandidate).toBeUndefined();
  });

  it('`/z new <text>` (a ZRouter continuation) is not a candidate', async () => {
    const h = harness();
    h.router.zRouter = { dispatch: vi.fn().mockResolvedValue({ handled: true, continueWithPrompt: '새 작업' }) };
    await h.fire({ text: '<@U_BOT> /z new 새 작업' });
    expect(h.forwarded().text).toBe('새 작업');
    expect(h.forwarded().routeContext?.taskEntryCandidate).toBeUndefined();
  });

  it('a `/z` text ZRouter did not take is not a candidate either', async () => {
    const h = harness();
    h.router.zRouter = { dispatch: vi.fn().mockResolvedValue({ handled: false }) };
    await h.fire({ text: '<@U_BOT> /z something' });
    expect(h.forwarded().routeContext?.taskEntryCandidate).toBeUndefined();
  });

  it('a DM or a synthetic event is not a candidate', async () => {
    const dm = harness();
    await dm.fire({ text: '<@U_BOT> 고쳐줘', channel: 'D123', channel_type: 'im' });
    expect(dm.forwarded().routeContext?.taskEntryCandidate).toBeUndefined();

    const synthetic = harness();
    await synthetic.fire({ text: '<@U_BOT> 고쳐줘', synthetic: true });
    expect(synthetic.forwarded().routeContext?.taskEntryCandidate).toBeUndefined();
  });

  it('a mention whose app_mention carries no files is judged on its words — the host re-checks files (fable #670 P2-1)', async () => {
    // Slack often delivers `@bot … + attachment` as an app_mention without `files`.
    const h = harness();
    await h.fire({ text: '<@U_BOT> 이 파일 봐줘' });
    expect(h.forwarded().routeContext?.taskEntryCandidate).toBe(true);
  });

  it('no bot id: the mention could not be stripped — no marker (fable #670 P3-4)', async () => {
    const h = harness();
    h.router.deps.slackApi.getBotUserId.mockRejectedValueOnce(new Error('auth.test failed'));
    await h.fire({ text: '<@U_BOT> /compact' });
    expect(h.forwarded().routeContext?.taskEntryCandidate).toBeUndefined();
  });

  it('a file mention is left to the file_share path — nothing is forwarded from app_mention', async () => {
    const h = harness();
    await h.fire({ text: '<@U_BOT> 이 파일 봐줘', files: [{ id: 'F1' }] });
    expect(h.messageHandler).not.toHaveBeenCalled();
  });

  it('the rule itself, for the host to re-check later', () => {
    const base = { channel: 'C1' };
    expect(isTaskEntryCandidate(base, '고쳐줘')).toBe(true);
    expect(isTaskEntryCandidate(base, '  ')).toBe(false);
    expect(isTaskEntryCandidate({ ...base, files: [{}] }, '고쳐줘')).toBe(false);
    expect(isTaskEntryCandidate({ channel: 'D1' }, '고쳐줘')).toBe(false);
    expect(isTaskEntryCandidate({ ...base, channel_type: 'im' }, '고쳐줘')).toBe(false);
    expect(isTaskEntryCandidate({ ...base, synthetic: true }, '고쳐줘')).toBe(false);
    expect(isTaskEntryCandidate(base, '/z new 고쳐줘')).toBe(false);
    expect(isTaskEntryCandidate(base, 'new 고쳐줘')).toBe(false);
    expect(isTaskEntryCandidate(base, '!고쳐줘')).toBe(false);
    expect(isTaskEntryCandidate(base, '%model opus')).toBe(false);
    // Naked commands and a forced skill are candidates: the host narrows (fable #670 P3-3).
    expect(isTaskEntryCandidate(base, '$review')).toBe(true);
    expect(isTaskEntryCandidate(base, 'persona linus')).toBe(true);
    // Only `/z` is the z prefix: a word that starts with z is an instruction.
    expect(isTaskEntryCandidate(base, 'zod 스키마 고쳐줘')).toBe(true);
  });
});
