import { describe, expect, it, vi } from 'vitest';

// Mock the autoskill firing module so the test controls what `buildAutoskillFire`
// returns (a stable banner we can assert on), independent of on-disk user skills.
vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => ({
    keys: ['user:U123:qa'],
    invokedBlock: '<invoked_skills>\n<user:U123:qa>\nQA\n</user:U123:qa>\n</invoked_skills>',
    banner: { text: '⚡ AUTOSKILL-FIRE-BANNER', color: '#00FF00' },
  })),
}));

import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * Regression: `new $skill` reset path must fire autogoal + autoskill + the
 * deferred forced `$skill`, in that order. The `new` reset keeps the session
 * object but clears `sessionId` (isNewSession=false, sessionId=undefined), so
 * the firing gate is `freshContextStart`, NOT `isNewSession`. Bug report:
 * "새새션 시작(new)를 할시에 autogoal이랑 autoskill이 발동되지 않음".
 */
describe('SlackHandler — new-reset autogoal/autoskill firing', () => {
  it('fires autogoal banner, autoskill banner, and deferred $skill banner on a `new` reset (isNewSession=false, sessionId=undefined)', async () => {
    // Autogoal ON for this user.
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(true);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);

    const app = { client: {}, assistant: vi.fn() } as any;

    // Pre-route session EXISTS with a sessionId — exactly the `new` reset case
    // (the session object survives the reset; sessionId was just cleared by
    // NewHandler before slack-handler re-enters). The registry session used by
    // the autogoal block starts goal-less.
    const registrySession: any = { ownerId: 'U123', channelId: 'C123', threadTs: '111.222' };
    const claudeHandler = {
      getSession: vi.fn().mockReturnValue({ ownerId: 'U123', sessionId: 'OLD-SID' }),
      getSessionByKey: vi.fn().mockReturnValue(registrySession),
      saveSessions: vi.fn(),
    };
    const handler = new SlackHandler(app as any, claudeHandler as any, {} as any);
    const handlerAny = handler as any;

    const postMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    const postSystemMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage,
      postSystemMessage,
    };

    // Reset-path route result: NewHandler re-routed `$z foo` and SkillForceHandler
    // deferred it (banner + block ride out-of-band on deferredSkillFire; the raw
    // remainder is the continueWithPrompt).
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({
        handled: true,
        continueWithPrompt: '$z foo',
        deferredSkillFire: {
          keys: ['local:z'],
          invokedBlock: '<invoked_skills>\n<local:z>\nBODY\n</local:z>\n</invoked_skills>',
          banner: { text: '⚡ DEFERRED-FIRE-BANNER', color: '#FF0000' },
        },
      }),
    };

    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue({
        // `new` reset: existing session reused, sessionId cleared.
        session: { ownerId: 'U123', channelId: 'C123', threadTs: '111.222', sessionId: undefined },
        sessionKey: 'C123:111.222',
        isNewSession: false,
        userName: 'T',
        workingDirectory: '/tmp',
        abortController: new AbortController(),
        halted: false,
      }),
    };
    handlerAny.streamExecutor = { execute: vi.fn().mockResolvedValue({ success: true, messageCount: 1 }) };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage({ user: 'U123', channel: 'C123', ts: '111.222', text: 'new $z foo' } as any, say);

    // 1) Autogoal banner posted (🤖 Autogoal …) via postSystemMessage.
    const autogoalCall = postSystemMessage.mock.calls.find((c: any[]) => String(c[1]).includes('Autogoal'));
    expect(autogoalCall, 'autogoal banner should be posted on `new` reset').toBeDefined();

    // 2) Autoskill banner posted as a green attachment.
    const autoskillCall = postMessage.mock.calls.find(
      (c: any[]) => c[2]?.attachments?.[0]?.text === '⚡ AUTOSKILL-FIRE-BANNER',
    );
    expect(autoskillCall, 'autoskill banner should be posted on `new` reset').toBeDefined();

    // 3) Deferred forced-`$skill` banner posted as a red attachment.
    const deferredCall = postMessage.mock.calls.find(
      (c: any[]) => c[2]?.attachments?.[0]?.text === '⚡ DEFERRED-FIRE-BANNER',
    );
    expect(deferredCall, 'deferred forced $skill banner should be posted on `new` reset').toBeDefined();

    // 4) Order contract (#1166): autogoal → autoskill → forced `$skill`.
    // Autogoal rides postSystemMessage; the two skill banners ride postMessage.
    // Use the shared invocationCallOrder to interleave them on one timeline.
    const orderOf = (m: ReturnType<typeof vi.fn>['mock'], pred: (c: any[]) => boolean): number => {
      const idx = m.calls.findIndex(pred);
      return idx >= 0 ? (m.invocationCallOrder[idx] as number) : Number.POSITIVE_INFINITY;
    };
    const autogoalAt = orderOf(postSystemMessage.mock, (c) => String(c[1]).includes('Autogoal'));
    const autoskillAt = orderOf(postMessage.mock, (c) => c[2]?.attachments?.[0]?.text === '⚡ AUTOSKILL-FIRE-BANNER');
    const deferredAt = orderOf(postMessage.mock, (c) => c[2]?.attachments?.[0]?.text === '⚡ DEFERRED-FIRE-BANNER');
    expect(autogoalAt).toBeLessThan(autoskillAt);
    expect(autoskillAt).toBeLessThan(deferredAt);
  });
});
