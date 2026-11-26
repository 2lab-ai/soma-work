/**
 * Integration tests for safe-stop on dispatch failure (#698).
 *
 * Trace: docs/archive/features/dispatch-safe-stop/trace.md (v3) §S2 — 8 tests covering
 * 4 drift sites + cleanup robustness + activation predicate.
 *
 * Site C (runDispatch forceWorkflow), and Site A (dispatchWorkflow catch) with
 * a failing classifier from a mocked dispatch service — its AD-2 activation
 * rule (safe-stop vs default drift).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSettings: vi.fn().mockReturnValue(undefined),
    createPendingUser: vi.fn(),
    getModelDisplayName: vi.fn().mockReturnValue('Opus 4.7'),
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
  DEFAULT_MODEL: 'claude-opus-4-8[1m]',
}));

vi.mock('../../../dispatch-service', () => ({ getDispatchService: vi.fn() }));

import { getDispatchService } from '../../../dispatch-service';
import { DispatchAbortError } from '../../dispatch-abort';
import { SessionInitializer } from '../session-initializer';

interface MockSession {
  channelId: string;
  threadTs: string;
  workflow?: string;
  state?: string;
  title?: string;
  handoffContext?: any;
  autoHandoffBudget?: number;
}

function buildInitializer(options: { transitionReturns?: boolean } = {}) {
  const sessionByKey = new Map<string, MockSession>();
  const transitionToMain = vi.fn((c: string, t: string, workflow: string, title?: string) => {
    const key = `${c}:${t}`;
    const s = sessionByKey.get(key);
    if (s) {
      s.workflow = workflow;
      s.state = 'MAIN';
      if (title) s.title = title;
    }
    return options.transitionReturns ?? true;
  });

  const mockClaudeHandler = {
    getSessionKey: vi.fn((c: string, t: string) => `${c}:${t}`),
    getSession: vi.fn((c: string, t: string) => sessionByKey.get(`${c}:${t}`)),
    needsDispatch: vi.fn().mockReturnValue(true),
    transitionToMain,
    saveSessions: vi.fn(),
    setActivityState: vi.fn(),
  };
  const slackApi = {
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue({ ts: 'dispatch_ts' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };

  const sessionInitializer = new SessionInitializer({
    claudeHandler: mockClaudeHandler as any,
    slackApi: slackApi as any,
    messageValidator: {} as any,
    workingDirManager: {} as any,
    reactionManager: {} as any,
    contextWindowManager: {} as any,
    requestCoordinator: {} as any,
  });

  const primeSession = (channel: string, threadTs: string, overrides: Partial<MockSession> = {}): MockSession => {
    const s: MockSession = { channelId: channel, threadTs, ...overrides };
    sessionByKey.set(`${channel}:${threadTs}`, s);
    return s;
  };

  return { sessionInitializer, mockClaudeHandler, primeSession, transitionToMain, slackApi };
}

describe('runDispatch forceWorkflow — Site C (#698)', () => {
  it('T2.8a forceWorkflow="pr-review" + transitionToMain returns true → no throw, session transitioned', async () => {
    const { sessionInitializer, primeSession } = buildInitializer({ transitionReturns: true });
    primeSession('C1', 't1');

    await expect(
      sessionInitializer.runDispatch('C1', 't1', 'https://github.com/x/y/pull/1', 'pr-review'),
    ).resolves.not.toThrow();
  });

  it('T2.8 forceWorkflow="pr-review" + transitionToMain returns false → DispatchAbortError (reason=transition-failed, workflow=pr-review)', async () => {
    const { sessionInitializer, primeSession } = buildInitializer({ transitionReturns: false });
    primeSession('C1', 't2', { handoffContext: { chainId: 'abc', handoffKind: 'plan-to-work' } as any });

    const err = await sessionInitializer.runDispatch('C1', 't2', 'https://github.com/x/y/pull/1', 'pr-review').then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DispatchAbortError);
    expect(err).toMatchObject({
      reason: 'transition-failed',
      workflow: 'pr-review',
      handoffContext: { chainId: 'abc' },
    });
  });

  it('T2.9 forceWorkflow="onboarding" + transitionToMain returns false → DispatchAbortError with workflow="onboarding"', async () => {
    const { sessionInitializer, primeSession } = buildInitializer({ transitionReturns: false });
    primeSession('C1', 't3');

    try {
      await sessionInitializer.runDispatch('C1', 't3', 'onboarding', 'onboarding');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchAbortError);
      expect((err as DispatchAbortError).workflow).toBe('onboarding');
    }
  });
});

describe('dispatch failure → safe-stop vs default drift — AD-2 activation (#698)', () => {
  // A classifier failure safe-stops (DispatchAbortError) only when the session
  // entered through a z-handoff (handoffContext) or the caller forced a
  // workflow hint; otherwise the session drifts to `default` as before.
  function failingClassifier() {
    vi.mocked(getDispatchService).mockReturnValue({
      getModel: vi.fn().mockReturnValue('claude-haiku'),
      isReady: vi.fn().mockReturnValue(true),
      dispatch: vi.fn().mockRejectedValue(new Error('classifier exploded')),
    } as any);
  }

  it('T2.10 session with handoffContext → DispatchAbortError(classifier-failed) and the safe-stop panel text', async () => {
    failingClassifier();
    const { sessionInitializer, primeSession, transitionToMain, slackApi } = buildInitializer();
    primeSession('C1', 't10', { handoffContext: { chainId: 'abc', handoffKind: 'plan-to-work' } });

    const err = await sessionInitializer.runDispatch('C1', 't10', 'continue the plan').catch((e) => e);

    expect(err).toBeInstanceOf(DispatchAbortError);
    expect((err as DispatchAbortError).reason).toBe('classifier-failed');
    expect((err as DispatchAbortError).handoffContext?.chainId).toBe('abc');
    expect(slackApi.updateMessage).toHaveBeenCalledWith('C1', 'dispatch_ts', expect.stringContaining('safe-stop'));
    expect(transitionToMain).not.toHaveBeenCalled();
  });

  it('T2.11 session without handoffContext + no hint → drifts to the default workflow (no throw)', async () => {
    failingClassifier();
    const { sessionInitializer, primeSession, transitionToMain, slackApi } = buildInitializer();
    primeSession('C1', 't11');

    await expect(sessionInitializer.runDispatch('C1', 't11', 'fix the login bug')).resolves.toBeUndefined();

    expect(transitionToMain).toHaveBeenCalledWith('C1', 't11', 'default', expect.any(String));
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'dispatch_ts',
      expect.stringContaining('*Workflow:* `default`'),
    );
  });

  it('T2.12 session without handoffContext + forcedWorkflowHint → DispatchAbortError naming the hinted workflow', async () => {
    failingClassifier();
    const { sessionInitializer, primeSession, transitionToMain } = buildInitializer();
    primeSession('C1', 't12');

    const err = await (sessionInitializer as any)
      .dispatchWorkflow('C1', 't12', 'https://github.com/x/y/pull/1', 'C1:t12', 'pr-review')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DispatchAbortError);
    expect((err as DispatchAbortError).workflow).toBe('pr-review');
    expect(transitionToMain).not.toHaveBeenCalled();
  });

  it('T2.13 no session + no hint → drifts to default (nothing to protect, no throw)', async () => {
    failingClassifier();
    const { sessionInitializer, transitionToMain } = buildInitializer();

    await expect(sessionInitializer.runDispatch('C1', 't13', 'hello')).resolves.toBeUndefined();

    expect(transitionToMain).toHaveBeenCalledWith('C1', 't13', 'default', expect.any(String));
  });
});
