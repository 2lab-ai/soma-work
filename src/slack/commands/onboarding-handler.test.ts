import { describe, expect, it, vi } from 'vitest';
import { OnboardingHandler } from './onboarding-handler';

describe('OnboardingHandler', () => {
  it('blocks onboarding start while a request is active', async () => {
    const deps: any = {
      claudeHandler: {
        getSessionKey: vi.fn().mockReturnValue('C1:171.100'),
      },
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(true),
      },
      slackApi: {
        postSystemMessage: vi.fn().mockResolvedValue(undefined),
      },
    };

    const handler = new OnboardingHandler(deps);
    const result = await handler.execute({
      user: 'U1',
      channel: 'C1',
      threadTs: '171.100',
      text: '/onboarding',
      say: vi.fn(),
    });

    expect(result).toEqual({ handled: true });
    expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('Cannot start onboarding while a request is in progress'),
      { threadTs: '171.100' }
    );
  });

  it('forces onboarding workflow and resets existing session context', async () => {
    const session: any = {
      sessionId: 'session-1',
      isOnboarding: false,
    };

    const deps: any = {
      claudeHandler: {
        getSessionKey: vi.fn().mockReturnValue('C1:171.100'),
        getSession: vi.fn().mockReturnValue(session),
        resetSessionContext: vi.fn().mockImplementation(() => {
          session.sessionId = undefined;
          return true;
        }),
      },
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(false),
      },
      slackApi: {
        postSystemMessage: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
      },
      contextWindowManager: {
        cleanupWithReaction: vi.fn().mockResolvedValue(null),
      },
      reactionManager: {
        getOriginalMessage: vi.fn().mockReturnValue(null),
        getCurrentReaction: vi.fn().mockReturnValue(null),
        cleanup: vi.fn(),
      },
    };

    const handler = new OnboardingHandler(deps);
    const result = await handler.execute({
      user: 'U1',
      channel: 'C1',
      threadTs: '171.100',
      text: '/onboarding',
      say: vi.fn(),
    });

    expect(deps.claudeHandler.resetSessionContext).toHaveBeenCalledWith('C1', '171.100');
    expect(session.isOnboarding).toBe(true);
    expect(result.forceWorkflow).toBe('onboarding');
    expect(result.continueWithPrompt).toBe('온보딩을 시작해줘.');
  });

  it('returns onboarding force-workflow even without an existing session', async () => {
    const deps: any = {
      claudeHandler: {
        getSessionKey: vi.fn().mockReturnValue('C1:171.100'),
        getSession: vi.fn().mockReturnValue(undefined),
      },
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(false),
      },
      slackApi: {
        postSystemMessage: vi.fn().mockResolvedValue(undefined),
      },
    };

    const handler = new OnboardingHandler(deps);
    const result = await handler.execute({
      user: 'U1',
      channel: 'C1',
      threadTs: '171.100',
      text: '/onboarding 한국어로 진행해줘',
      say: vi.fn(),
    });

    expect(result.handled).toBe(true);
    expect(result.forceWorkflow).toBe('onboarding');
    expect(result.continueWithPrompt).toBe('한국어로 진행해줘');
  });
});
