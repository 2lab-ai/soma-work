import { describe, expect, it, vi } from 'vitest';
import { RenewHandler } from './renew-handler';

describe('RenewHandler', () => {
  it('clears stale renewSaveResult before starting a new renew flow', async () => {
    const session: any = {
      sessionId: 'session-1',
      renewState: null,
      renewSaveResult: {
        success: true,
        id: 'stale-save-id',
      },
    };

    const deps: any = {
      claudeHandler: {
        getSessionKey: vi.fn().mockReturnValue('C1:171.100'),
        getSession: vi.fn().mockReturnValue(session),
      },
      requestCoordinator: {
        isRequestActive: vi.fn().mockReturnValue(false),
      },
      slackApi: {
        postSystemMessage: vi.fn().mockResolvedValue(undefined),
      },
    };

    const handler = new RenewHandler(deps);
    const result = await handler.execute({
      user: 'U1',
      channel: 'C1',
      threadTs: '171.100',
      text: '/renew PR 리뷰 이어서 진행',
      say: vi.fn(),
    });

    expect(result.handled).toBe(true);
    expect(result.continueWithPrompt).toContain('SAVE_CONTEXT_RESULT');
    expect(session.renewState).toBe('pending_save');
    expect(session.renewSaveResult).toBeUndefined();
  });
});
