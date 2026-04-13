import { describe, expect, it, vi } from 'vitest';

// Mock user-settings-store (used by ThreadHeaderBuilder / ActionPanelBuilder)
vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('default'),
    getUserSettings: vi.fn().mockReturnValue(undefined),
  },
}));

// Mock source-thread-summary (fire-and-forget in handleClose)
vi.mock('../source-thread-summary', () => ({
  postSourceThreadSummary: vi.fn().mockResolvedValue(undefined),
}));

// Mock link-metadata-fetcher (imported by action-panel-action-handler)
vi.mock('../../link-metadata-fetcher', () => ({
  fetchGitHubPRDetails: vi.fn().mockResolvedValue(null),
  fetchGitHubPRReviewStatus: vi.fn().mockResolvedValue(null),
  isPRMergeable: vi.fn().mockReturnValue(false),
  mergeGitHubPR: vi.fn().mockResolvedValue({ success: false }),
}));

// Mock channel-registry (imported by action-panel-action-handler)
vi.mock('../../channel-registry', () => ({
  getChannelConfluenceUrl: vi.fn().mockReturnValue(undefined),
}));

// Trace: Session Close UI Race Condition — regression tests for the fix
// that ensures the thread header shows "종료됨" (closed) instead of
// "사용 가능" (available) after closing a session via the close button.

describe('Session Close UI Race Condition', () => {
  // Test 1: When isActive=false, buildCombinedBlocks should render closed blocks
  // even if no explicit closed override is passed (abort handler race scenario)
  it('renders closed state when session.isActive is false (abort-after-close race)', async () => {
    const { ThreadSurface } = await import('../thread-surface.js');

    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '100.200' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    const claudeHandler = { getSessionByKey: vi.fn() };
    const requestCoordinator = { isRequestActive: vi.fn().mockReturnValue(false) };
    const todoManager = { getTodos: vi.fn().mockReturnValue([]) };

    const surface = new ThreadSurface({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: todoManager as any,
    });

    const session: any = {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: '1.1',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
      workflow: 'default',
      links: {},
      actionPanel: { messageTs: '100.200' },
    };

    // First render: active state (updatePanel triggers renderViaFlush)
    await surface.updatePanel(session, 'C1:1.1');

    // Simulate close: set isActive=false (as the fix does before abort)
    session.isActive = false;

    // Simulate abort handler re-render (no closed override — just a normal updatePanel)
    await surface.updatePanel(session, 'C1:1.1');

    // The last updateMessage call should contain closed blocks (🔒 or 종료)
    const calls = slackApi.updateMessage.mock.calls;
    const lastCall = calls[calls.length - 1];
    const blocks = lastCall?.[3] || [];
    const allText = JSON.stringify(blocks);
    // Closed state should show lock emoji or "종료" text
    expect(allText).toMatch(/🔒|종료/);
  });

  // Test 2: ThreadSurface.close() renders closed blocks and cleans up
  it('ThreadSurface.close() renders closed blocks and cleans up', async () => {
    const { ThreadSurface } = await import('../thread-surface.js');

    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({ ts: '100.200' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    const claudeHandler = { getSessionByKey: vi.fn() };
    const requestCoordinator = { isRequestActive: vi.fn().mockReturnValue(false) };
    const todoManager = { getTodos: vi.fn().mockReturnValue([]) };

    const surface = new ThreadSurface({
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: todoManager as any,
    });

    const session: any = {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: '1.1',
      isActive: false, // already deactivated before close() is called
      lastActivity: new Date(),
      activityState: 'idle',
      workflow: 'default',
      links: {},
      actionPanel: { messageTs: '100.200' },
    };

    await surface.close(session, 'C1:1.1');

    // Should have called updateMessage with closed blocks
    expect(slackApi.updateMessage).toHaveBeenCalled();
    const blocks = slackApi.updateMessage.mock.calls[0]?.[3] || [];
    const allText = JSON.stringify(blocks);
    expect(allText).toMatch(/🔒|종료/);
  });

  // Test 3: ActionPanelActionHandler.handleClose fallback includes header+panel blocks
  it('ActionPanelActionHandler.handleClose fallback includes header+panel blocks', async () => {
    const { ActionPanelActionHandler } = await import('../actions/action-panel-action-handler.js');

    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const handler = new ActionPanelActionHandler({
      slackApi: {
        postMessage: vi.fn(),
        updateMessage,
      } as any,
      claudeHandler: {
        getSessionByKey: vi.fn().mockReturnValue({
          ownerId: 'U1',
          channelId: 'C1',
          threadTs: '1.1',
          isActive: true,
          activityState: 'idle',
          links: {},
          actionPanel: { messageTs: '100.200' },
          workflow: 'default',
          lastActivity: new Date(),
        }),
        terminateSession: vi.fn().mockReturnValue(true),
      } as any,
      messageHandler: vi.fn(),
      // No threadPanel — forces fallback path
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const body = {
      user: { id: 'U1' },
      actions: [{ value: JSON.stringify({ sessionKey: 'C1:1.1', action: 'close' }) }],
    };

    await handler.handleAction(body, respond as any);

    // Verify updateMessage was called (fallback path)
    expect(updateMessage).toHaveBeenCalled();
    const blocks = updateMessage.mock.calls[0]?.[3] || [];

    // Should have multiple block types — at minimum header section + panel section
    // Header blocks include session info, panel blocks include status/actions
    expect(blocks.length).toBeGreaterThan(1);

    // Should contain closed indicators
    const allText = JSON.stringify(blocks);
    expect(allText).toMatch(/🔒|종료/);
  });
});
