import { getVerbosityFlags, LOG_MINIMAL } from '@soma/slack/output-flags';
import { setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import type { WorkLogInput } from '@soma/slack/work-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable autoskill fire: each test decides whether the user has
// autoskills registered (a stable banner it can assert on, or none).
const h = vi.hoisted(() => ({ buildAutoskillFire: vi.fn() }));
vi.mock('../slack/autoskill-fire', () => ({ buildAutoskillFire: h.buildAutoskillFire }));

import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

const AUTOSKILL_FIRE = {
  keys: ['user:U123:qa'],
  invokedBlock: '<invoked_skills>\n<user:U123:qa>\nQA\n</user:U123:qa>\n</invoked_skills>',
  banner: { text: '⚡ AUTOSKILL-FIRE-BANNER', color: '#FF0000' },
};
const DEFERRED_FIRE = {
  keys: ['local:z'],
  invokedBlock: '<invoked_skills>\n<local:z>\nBODY\n</local:z>\n</invoked_skills>',
  banner: { text: '⚡ DEFERRED-FIRE-BANNER', color: '#FF0000' },
};
const COMPACT = getVerbosityFlags('compact');

/**
 * The two fresh-context banners slack-handler posts itself — the autoskill
 * fire and the deferred first-instruction `$skill` — reach the thread only when
 * the session's mask carries `SKILL_INVOCATION`. Each is recorded in the
 * conversation's work log as a `notice` at every level; the `<invoked_skills>`
 * blocks always reach the dispatch prompt.
 */
describe('SlackHandler — forced-skill banners follow the session verbosity', () => {
  const recorded: Array<[string, WorkLogInput]> = [];

  beforeEach(() => {
    recorded.length = 0;
    setStreamExecutorProviders({
      appendWorkLog: (conversationId, entry) => {
        recorded.push([conversationId, entry]);
      },
    });
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
  });

  afterEach(() => {
    setStreamExecutorProviders({ appendWorkLog: () => {} });
    vi.restoreAllMocks();
    h.buildAutoskillFire.mockReset();
  });

  async function run(opts: { logVerbosity: number | undefined; autoskill: boolean; deferred: boolean }) {
    h.buildAutoskillFire.mockReturnValue(opts.autoskill ? AUTOSKILL_FIRE : null);
    const app = { client: {}, assistant: vi.fn() } as any;
    const claudeHandler = {
      getSession: vi.fn().mockReturnValue(undefined),
      getSessionByKey: vi.fn().mockReturnValue(undefined),
      saveSessions: vi.fn(),
    };
    const handler = new SlackHandler(app, claudeHandler as any, {} as any);
    const handlerAny = handler as any;

    const postMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage,
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
    };
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi
        .fn()
        .mockResolvedValue(
          opts.deferred
            ? { handled: true, continueWithPrompt: '$z foo', deferredSkillFire: DEFERRED_FIRE }
            : { handled: false },
        ),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue({
        session: {
          ownerId: 'U123',
          channelId: 'C123',
          threadTs: '111.222',
          sessionId: undefined,
          conversationId: 'conv-1',
          logVerbosity: opts.logVerbosity,
        },
        sessionKey: 'C123:111.222',
        isNewSession: true,
        userName: 'T',
        workingDirectory: '/tmp',
        abortController: new AbortController(),
        halted: false,
      }),
    };
    const execute = vi.fn().mockResolvedValue({ success: true, messageCount: 1 });
    handlerAny.streamExecutor = { execute };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage({ user: 'U123', channel: 'C123', ts: '111.222', text: '$z foo' } as any, say);

    expect(execute).toHaveBeenCalledTimes(1);
    const posted = (text: string) => postMessage.mock.calls.filter((c: any[]) => c[2]?.attachments?.[0]?.text === text);
    const notices = recorded.filter(([, entry]) => entry.kind === 'notice');
    return { posted, notices, dispatched: execute.mock.calls[0][0].text as string };
  }

  describe('autoskill fire on a fresh-context start', () => {
    it('minimal: no banner post, one work-log notice, the autoskill block still dispatched', async () => {
      const { posted, notices, dispatched } = await run({
        logVerbosity: LOG_MINIMAL,
        autoskill: true,
        deferred: false,
      });

      expect(posted(AUTOSKILL_FIRE.banner.text)).toHaveLength(0);
      expect(notices).toEqual([
        ['conv-1', { kind: 'notice', text: AUTOSKILL_FIRE.banner.text, ts: expect.any(Number) }],
      ]);
      expect(dispatched).toContain(AUTOSKILL_FIRE.invokedBlock);
    });

    it('compact: banner posted as today, and recorded', async () => {
      const { posted, notices, dispatched } = await run({ logVerbosity: COMPACT, autoskill: true, deferred: false });

      const calls = posted(AUTOSKILL_FIRE.banner.text);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('C123');
      expect(calls[0][2]).toMatchObject({ threadTs: '111.222', attachments: [{ color: '#FF0000' }] });
      expect(notices).toEqual([
        ['conv-1', { kind: 'notice', text: AUTOSKILL_FIRE.banner.text, ts: expect.any(Number) }],
      ]);
      expect(dispatched).toContain(AUTOSKILL_FIRE.invokedBlock);
    });
  });

  describe('deferred first-instruction $skill', () => {
    it('minimal: no banner post, one work-log notice, the $skill block still dispatched', async () => {
      const { posted, notices, dispatched } = await run({
        logVerbosity: LOG_MINIMAL,
        autoskill: false,
        deferred: true,
      });

      expect(posted(DEFERRED_FIRE.banner.text)).toHaveLength(0);
      expect(notices).toEqual([
        ['conv-1', { kind: 'notice', text: DEFERRED_FIRE.banner.text, ts: expect.any(Number) }],
      ]);
      expect(dispatched).toContain(DEFERRED_FIRE.invokedBlock);
    });

    it('compact: banner posted as today, and recorded', async () => {
      const { posted, notices, dispatched } = await run({ logVerbosity: COMPACT, autoskill: false, deferred: true });

      expect(posted(DEFERRED_FIRE.banner.text)).toHaveLength(1);
      expect(notices).toEqual([
        ['conv-1', { kind: 'notice', text: DEFERRED_FIRE.banner.text, ts: expect.any(Number) }],
      ]);
      expect(dispatched).toContain(DEFERRED_FIRE.invokedBlock);
    });

    it('unset mask reads as detail: banner posted as today', async () => {
      const { posted } = await run({ logVerbosity: undefined, autoskill: false, deferred: true });

      expect(posted(DEFERRED_FIRE.banner.text)).toHaveLength(1);
    });
  });

  it('minimal with both: neither banner posted, two notices in fire order (autoskill → $skill)', async () => {
    const { posted, notices, dispatched } = await run({ logVerbosity: LOG_MINIMAL, autoskill: true, deferred: true });

    expect(posted(AUTOSKILL_FIRE.banner.text)).toHaveLength(0);
    expect(posted(DEFERRED_FIRE.banner.text)).toHaveLength(0);
    expect(notices.map(([, entry]) => entry.text)).toEqual([AUTOSKILL_FIRE.banner.text, DEFERRED_FIRE.banner.text]);
    expect(dispatched.indexOf(AUTOSKILL_FIRE.invokedBlock)).toBeLessThan(
      dispatched.indexOf(DEFERRED_FIRE.invokedBlock),
    );
  });
});
