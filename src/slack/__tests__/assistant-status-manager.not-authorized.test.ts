import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantStatusManager } from '../assistant-status-manager';
import type { SlackApiHelper } from '../slack-api-helper';

/**
 * `not_authorized` from Slack's status call is a fact about ONE thread (the app
 * may not set a status there), not about the app: in the same 23-minute window
 * on a busy host 34 of 788 calls succeeded in other threads. Retrying it on
 * every 20 s heartbeat spent 754 of 2,575 Slack calls — about 30% of the whole
 * host's serial Slack lane — on a call that could not succeed, and every turn's
 * rendering waited behind them.
 *
 * So the thread stops trying for the rest of the turn; the manager stays on for
 * every other thread, and the next turn may try once more.
 */

const notAuthorized = () => Object.assign(new Error('not_authorized'), { data: { error: 'not_authorized' } });

const createMockSlackApi = () => ({
  setAssistantStatus: vi.fn().mockResolvedValue(undefined),
  setAssistantTitle: vi.fn().mockResolvedValue(undefined),
});

describe('AssistantStatusManager — not_authorized stops one thread, not the app', () => {
  let slackApi: ReturnType<typeof createMockSlackApi>;
  let manager: AssistantStatusManager;

  beforeEach(() => {
    vi.useFakeTimers();
    slackApi = createMockSlackApi();
    manager = new AssistantStatusManager(slackApi as unknown as SlackApiHelper);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const callsFor = (threadTs: string) =>
    slackApi.setAssistantStatus.mock.calls.filter(([, ts]) => ts === threadTs).length;

  it('a thread that answered not_authorized is not retried on the heartbeat', async () => {
    slackApi.setAssistantStatus.mockRejectedValueOnce(notAuthorized());

    await manager.setStatus('C1', '1.1', 'is thinking...');
    expect(callsFor('1.1')).toBe(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(callsFor('1.1')).toBe(1);
    expect(manager.isEnabled()).toBe(true);
  });

  it('other threads keep their status and heartbeat', async () => {
    await manager.setStatus('C2', '2.2', 'is reading files...');
    slackApi.setAssistantStatus.mockRejectedValueOnce(notAuthorized());
    await manager.setStatus('C1', '1.1', 'is thinking...');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(callsFor('1.1')).toBe(1);
    // 1 explicit write + 3 heartbeat ticks.
    expect(callsFor('2.2')).toBe(4);
    expect(manager.isEnabled()).toBe(true);
  });

  it('later status changes and the clear of that turn send nothing for that thread', async () => {
    slackApi.setAssistantStatus.mockRejectedValueOnce(notAuthorized());
    await manager.setStatus('C1', '1.1', 'is thinking...');

    await manager.setStatus('C1', '1.1', 'is editing code...');
    await manager.clearStatus('C1', '1.1');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(callsFor('1.1')).toBe(1);
  });

  it('a write already queued behind the refused one is not sent', async () => {
    let refuse!: (error: unknown) => void;
    slackApi.setAssistantStatus.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          refuse = reject;
        }),
    );

    const first = manager.setStatus('C1', '1.1', 'is thinking...');
    const second = manager.setStatus('C1', '1.1', 'is editing code...');
    refuse(notAuthorized());
    await Promise.all([first, second]);

    expect(callsFor('1.1')).toBe(1);
  });

  it('the next turn may try the thread once more', async () => {
    slackApi.setAssistantStatus.mockRejectedValueOnce(notAuthorized());
    await manager.setStatus('C1', '1.1', 'is thinking...');
    expect(callsFor('1.1')).toBe(1);

    manager.bumpEpoch('C1', '1.1');
    await manager.setStatus('C1', '1.1', 'is thinking...');

    expect(callsFor('1.1')).toBe(2);
    // And it succeeded this time, so the heartbeat runs again.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(callsFor('1.1')).toBe(3);
  });

  it('a transient error is still retried on the heartbeat', async () => {
    slackApi.setAssistantStatus.mockRejectedValueOnce(
      Object.assign(new Error('ratelimited'), { data: { error: 'ratelimited' } }),
    );
    await manager.setStatus('C1', '1.1', 'is thinking...');

    await vi.advanceTimersByTimeAsync(20_000);

    expect(callsFor('1.1')).toBe(2);
  });
});
