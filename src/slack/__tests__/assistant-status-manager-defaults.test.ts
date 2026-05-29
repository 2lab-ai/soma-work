import { afterEach, describe, expect, it, vi } from 'vitest';

// The 5-block UI and the native assistant-status spinner are the PERMANENT
// default. These tests pin the user intent: "delete the env gates and make
// their on-state the default". They drive the @soma/slack package classes
// directly (which read the rollout env vars in their default providers) with
// the env vars EXPLICITLY UNSET — no `.env` opt-in. Before the gate removal
// they are RED (phase resolves to 0, native status disabled); after the
// refactor the behavior is env-independent and they go GREEN.

const createMockSlackApi = () => ({
  setAssistantStatus: vi.fn().mockResolvedValue(undefined),
  setAssistantTitle: vi.fn().mockResolvedValue(undefined),
});

const createThreadPanelDeps = () => ({
  slackApi: { postMessage: vi.fn(), updateMessage: vi.fn(), postEphemeral: vi.fn() } as any,
  claudeHandler: { getSessionByKey: vi.fn() } as any,
  requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
  todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
  slackBlockKitChannel: { send: vi.fn().mockResolvedValue(undefined) } as any,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('5-block UI default (no SOMA_UI_5BLOCK_PHASE opt-in)', () => {
  it('treats the per-turn stream façade and B5 completion marker as active', async () => {
    vi.stubEnv('SOMA_UI_5BLOCK_PHASE', '');

    const { ThreadPanel } = await import('@soma/slack/thread-panel');
    const panel = new ThreadPanel(createThreadPanelDeps());

    expect(panel.isTurnSurfaceActive()).toBe(true);
    expect(panel.isCompletionMarkerActive()).toBe(true);
  });
});

describe('Native assistant status default (no SOMA_UI_B4_NATIVE_STATUS opt-in)', () => {
  it('enables the native status spinner', async () => {
    vi.stubEnv('SOMA_UI_B4_NATIVE_STATUS', '');

    const { AssistantStatusManager } = await import('@soma/slack/assistant-status-manager');
    const manager = new AssistantStatusManager(createMockSlackApi() as any);

    expect(manager.isEnabled()).toBe(true);
  });
});
