import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackApiHelper } from '../slack/slack-api-helper';
import type { ConversationSession, SessionUsage } from '../types';
import type { UserSettingsStore } from '../user-settings-store';
import { checkAndSchedulePendingCompact, computeContextUsagePct } from './compact-threshold-checker';

function makeUsage(input: number, contextWindow = 100_000): SessionUsage {
  return {
    currentInputTokens: input,
    currentOutputTokens: 0,
    currentCacheReadTokens: 0,
    currentCacheCreateTokens: 0,
    contextWindow,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreateTokens: 0,
    totalCostUsd: 0,
    lastUpdated: Date.now(),
  };
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    model: 'claude-opus-4-7',
    compactionCount: 0,
    compactEpoch: 0,
    compactPostedByEpoch: {},
    compactionRehydratedByEpoch: {},
    preCompactUsagePct: null,
    lastKnownUsagePct: null,
    autoCompactPending: false,
    pendingUserText: null,
    pendingEventContext: null,
    ...overrides,
  } as ConversationSession;
}

/**
 * #617 AC3 — turn-end threshold checker.
 */
describe('computeContextUsagePct (#617 AC3 helper)', () => {
  it('AC3: returns undefined when session has no usage', () => {
    const session = makeSession();
    expect(computeContextUsagePct(session)).toBeUndefined();
  });

  it('AC3: computes integer percent from input+output+cache tokens', () => {
    const session = makeSession({ usage: makeUsage(80_000, 100_000) });
    expect(computeContextUsagePct(session)).toBe(80);
  });

  it('AC3: rounds to nearest integer (not truncate)', () => {
    const session = makeSession({ usage: makeUsage(79_500, 100_000) });
    // 79.5 rounds up to 80
    expect(computeContextUsagePct(session)).toBe(80);
  });

  it('AC3: clamps to 100 when tokens exceed contextWindow', () => {
    const session = makeSession({ usage: makeUsage(150_000, 100_000) });
    expect(computeContextUsagePct(session)).toBe(100);
  });

  it('AC3: clamps to 0 floor (sanity)', () => {
    const session = makeSession({ usage: makeUsage(0, 100_000) });
    expect(computeContextUsagePct(session)).toBe(0);
  });
});

describe('checkAndSchedulePendingCompact (#617 AC3)', () => {
  let slackApi: { postSystemMessage: ReturnType<typeof vi.fn> };
  let userSettings: { getUserCompactThreshold: ReturnType<typeof vi.fn> };
  let session: ConversationSession;

  beforeEach(() => {
    slackApi = { postSystemMessage: vi.fn().mockResolvedValue(undefined) };
    userSettings = { getUserCompactThreshold: vi.fn().mockReturnValue(80) };
    session = makeSession({ usage: makeUsage(0, 100_000) });
  });

  async function run(): Promise<boolean> {
    return checkAndSchedulePendingCompact({
      session,
      userId: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      userSettings: userSettings as unknown as UserSettingsStore,
      slackApi: slackApi as unknown as SlackApiHelper,
    });
  }

  it('AC3: below threshold (79/80) → returns false, no post, no flag', async () => {
    session.usage = makeUsage(79_000, 100_000);
    const result = await run();
    expect(result).toBe(false);
    expect(session.autoCompactPending).toBe(false);
    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
    // But lastKnownUsagePct is still recorded for fallback Y%
    expect(session.lastKnownUsagePct).toBe(79);
  });

  it('AC3: at threshold (80/80) → returns true, sets flag, posts announce', async () => {
    session.usage = makeUsage(80_000, 100_000);
    const result = await run();
    expect(result).toBe(true);
    expect(session.autoCompactPending).toBe(true);
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith(
      'C1',
      expect.stringMatching(/Context usage 80% ≥ threshold 80% — next turn will auto \/compact/),
      { threadTs: 'T1' },
    );
    expect(session.lastKnownUsagePct).toBe(80);
  });

  it('AC3: above threshold (95/80) → triggers with actual pct in message', async () => {
    session.usage = makeUsage(95_000, 100_000);
    const result = await run();
    expect(result).toBe(true);
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Context usage 95%'), {
      threadTs: 'T1',
    });
  });

  it('AC3: idempotent — autoCompactPending already true → no-op, no duplicate post', async () => {
    session.usage = makeUsage(85_000, 100_000);
    session.autoCompactPending = true;
    const result = await run();
    expect(result).toBe(false);
    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
  });

  it('AC3: reset after compaction → can fire again', async () => {
    session.usage = makeUsage(85_000, 100_000);
    // 1st run: fires
    expect(await run()).toBe(true);
    expect(session.autoCompactPending).toBe(true);

    // Simulate PostCompact hook resetting the flag (see §4.2 / §5.4).
    session.autoCompactPending = false;

    // 2nd run after another full window → fires again (supports N-compact per session).
    expect(await run()).toBe(true);
    expect(slackApi.postSystemMessage).toHaveBeenCalledTimes(2);
  });

  it('AC3: respects per-user threshold override (60) — fires at 65%', async () => {
    userSettings.getUserCompactThreshold.mockReturnValue(60);
    session.usage = makeUsage(65_000, 100_000);
    const result = await run();
    expect(result).toBe(true);
    expect(userSettings.getUserCompactThreshold).toHaveBeenCalledWith('U1');
    expect(slackApi.postSystemMessage).toHaveBeenCalledWith('C1', expect.stringContaining('≥ threshold 60%'), {
      threadTs: 'T1',
    });
  });

  it('AC3: missing usage → returns false without post', async () => {
    session.usage = undefined;
    const result = await run();
    expect(result).toBe(false);
    expect(slackApi.postSystemMessage).not.toHaveBeenCalled();
  });

  it('AC3: slackPost failure does NOT revert autoCompactPending — next turn still compacts', async () => {
    session.usage = makeUsage(90_000, 100_000);
    slackApi.postSystemMessage.mockRejectedValueOnce(new Error('slack 503'));
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

    const result = await checkAndSchedulePendingCompact({
      session,
      userId: 'U1',
      channel: 'C1',
      threadTs: 'T1',
      userSettings: userSettings as unknown as UserSettingsStore,
      slackApi: slackApi as unknown as SlackApiHelper,
      logger: logger as any,
    });

    // Flag must be set even when Slack fails (best-effort post).
    expect(result).toBe(true);
    expect(session.autoCompactPending).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
