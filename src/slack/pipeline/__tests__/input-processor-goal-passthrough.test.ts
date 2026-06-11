/**
 * Issue #1082 T1 — InputProcessor.routeCommand must pass `setGoalObjective`
 * from the CommandRouter result through to slack-handler. The field rides the
 * same narrow return object as `continueWithPrompt` / `forceWorkflow`; a
 * boundary that rebuilds the object field-by-field (as routeCommand does)
 * silently drops it unless explicitly forwarded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    updateUserJiraInfo: vi.fn(),
  },
}));

import { InputProcessor } from '../input-processor';
import type { MessageEvent } from '../types';

describe('InputProcessor — setGoalObjective passthrough (#1082)', () => {
  let commandRouterRoute: ReturnType<typeof vi.fn>;
  let processor: InputProcessor;

  const makeEvent = (text: string): MessageEvent =>
    ({
      type: 'message',
      channel: 'C1',
      thread_ts: 'T1',
      user: 'U1',
      ts: '171.0',
      text,
    }) as unknown as MessageEvent;

  beforeEach(() => {
    commandRouterRoute = vi.fn();
    processor = new InputProcessor({
      fileHandler: {} as any,
      commandRouter: { route: commandRouterRoute } as any,
      claudeHandler: { getSession: vi.fn().mockReturnValue(undefined) } as any,
      slackApi: { postSystemMessage: vi.fn().mockResolvedValue(undefined) } as any,
    });
  });

  it('forwards setGoalObjective on a fall-through result (plain `goal X`, no session)', async () => {
    commandRouterRoute.mockResolvedValue({ handled: false, setGoalObjective: 'ship the feature' });
    const say = vi.fn().mockResolvedValue({ ts: 'ts1' });

    const result = await processor.routeCommand(makeEvent('goal ship the feature'), say as any);

    expect(result.handled).toBe(false);
    expect(result.setGoalObjective).toBe('ship the feature');
  });

  it('forwards setGoalObjective alongside continueWithPrompt (goal+skill split)', async () => {
    commandRouterRoute.mockResolvedValue({
      handled: true,
      continueWithPrompt: '<invoked_skills>…</invoked_skills>',
      setGoalObjective: 'ship the feature',
    });
    const say = vi.fn().mockResolvedValue({ ts: 'ts1' });

    const result = await processor.routeCommand(makeEvent('goal ship the feature $z proceed'), say as any);

    expect(result.continueWithPrompt).toBe('<invoked_skills>…</invoked_skills>');
    expect(result.setGoalObjective).toBe('ship the feature');
  });

  it('leaves setGoalObjective undefined when the router does not set it', async () => {
    commandRouterRoute.mockResolvedValue({ handled: false });
    const say = vi.fn().mockResolvedValue({ ts: 'ts1' });

    const result = await processor.routeCommand(makeEvent('hello'), say as any);

    expect(result.setGoalObjective).toBeUndefined();
  });
});
