import { describe, expect, it, vi } from 'vitest';
import { RenewHandler } from '../renew-handler';

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
    expect(result.continueWithPrompt).toContain('ABSOLUTE path');
    expect(result.continueWithPrompt).toContain('"files"');
    expect(session.renewState).toBe('pending_save');
    expect(session.renewSaveResult).toBeUndefined();
  });

  function makeNoSessionDeps() {
    return {
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
    } as any;
  }

  it('falls through (handled:false) when no session and the message carries a free-form instruction', async () => {
    // "renew design the API" with no session is a fresh instruction that
    // happens to start with "renew", not a session-scoped command. The handler
    // returns unhandled so CommandRouter falls through and the message starts a
    // new conversation instead of being dropped with "No active session".
    const deps = makeNoSessionDeps();
    const handler = new RenewHandler(deps);

    const result = await handler.execute({
      user: 'U1',
      channel: 'C1',
      threadTs: '171.100',
      text: 'renew design the API',
      say: vi.fn(),
    });

    expect(result).toEqual({ handled: false });
    expect(deps.slackApi.postSystemMessage).not.toHaveBeenCalled();
  });

  it('shows a clear message when no session and the message is a bare renew command', async () => {
    const deps = makeNoSessionDeps();
    const handler = new RenewHandler(deps);

    const result = await handler.execute({
      user: 'U1',
      channel: 'C1',
      threadTs: '171.100',
      text: 'renew',
      say: vi.fn(),
    });

    expect(result).toEqual({ handled: true });
    expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('No active session'),
      expect.objectContaining({ threadTs: '171.100' }),
    );
  });

  it('treats a leading-whitespace bare ` /renew` as bare (no leaked instruction)', async () => {
    // The leading space must be trimmed before the slash anchor; otherwise
    // userMessage would become "/renew" (non-empty) and the handler would fall
    // through, leaking the ❓ unrecognized-command hint via CommandRouter.
    for (const text of [' /renew', ' renew', '  /renew  ']) {
      const deps = makeNoSessionDeps();
      const handler = new RenewHandler(deps);

      const result = await handler.execute({
        user: 'U1',
        channel: 'C1',
        threadTs: '171.100',
        text,
        say: vi.fn(),
      });

      expect(result).toEqual({ handled: true });
      expect(deps.slackApi.postSystemMessage).toHaveBeenCalledWith(
        'C1',
        expect.stringContaining('No active session'),
        expect.objectContaining({ threadTs: '171.100' }),
      );
    }
  });
});
