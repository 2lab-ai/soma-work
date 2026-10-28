import { describe, expect, it, vi } from 'vitest';
import { ActionPanelActionHandler } from '../action-panel-action-handler';

// The workflow-button actions (pr_*, issue_research, focus_choice) are gone;
// their stale-click behaviour is pinned by
// `action-panel-action-handler.removed-actions.test.ts`.
describe('ActionPanelActionHandler', () => {
  it('closes session via close action', async () => {
    const handler = new ActionPanelActionHandler({
      slackApi: {
        postMessage: vi.fn(),
      } as any,
      claudeHandler: {
        getSessionByKey: vi.fn().mockReturnValue({
          ownerId: 'U123',
          channelId: 'C123',
          threadTs: '111.222',
          activityState: 'idle',
          links: {},
        }),
        terminateSession: vi.fn().mockReturnValue(true),
      } as any,
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const body = {
      user: { id: 'U123' },
      actions: [
        {
          value: JSON.stringify({ sessionKey: 'session-1', action: 'close' }),
        },
      ],
    };

    await handler.handleAction(body, respond as any);

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('종료'),
      }),
    );
  });

  it('rejects a click from someone other than the session owner', async () => {
    const terminateSession = vi.fn();
    const handler = new ActionPanelActionHandler({
      slackApi: { postMessage: vi.fn() } as any,
      claudeHandler: {
        getSessionByKey: vi.fn().mockReturnValue({ ownerId: 'U123', channelId: 'C123', threadTs: '111.222' }),
        terminateSession,
      } as any,
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    await handler.handleAction(
      { user: { id: 'U999' }, actions: [{ value: JSON.stringify({ sessionKey: 'session-1', action: 'close' }) }] },
      respond as any,
    );

    expect(terminateSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: '❌ 세션 소유자만 이 작업을 수행할 수 있습니다.' }),
    );
  });
});
