import { describe, expect, it, vi } from 'vitest';
import { ThreadPanel } from '../thread-panel';

// The 5-block UI is the PERMANENT default (#1017): every turn opens the per-turn stream façade — there is no rollout
// switch that turns it off.

const createThreadPanelDeps = () => ({
  slackApi: { postMessage: vi.fn(), updateMessage: vi.fn(), postEphemeral: vi.fn() } as any,
  claudeHandler: { getSessionByKey: vi.fn() } as any,
  requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
  todoManager: { getTodos: vi.fn().mockReturnValue([]) } as any,
});

describe('5-block UI default', () => {
  it('treats the per-turn stream façade as active', () => {
    expect(new ThreadPanel(createThreadPanelDeps()).isTurnSurfaceActive()).toBe(true);
  });
});
