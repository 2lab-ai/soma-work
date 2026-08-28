/**
 * One meaning for the context percentage (issue #196).
 *
 * The same 674,800 tokens in a 1M window used to render as "(67.5%)" in the
 * turn-completion footer and "(32.5%)" in the `/context` card — identical
 * visual shape, opposite meaning. The footer counted what was used; the card
 * and the thread header counted what was left. A reader had no way to tell
 * which, because both sat next to the same `674.8k/1M` token pair.
 *
 * Every surface now reports USED and says so. The token pair already reads
 * used-over-total and the bar already fills by used, so used is the reading
 * that matches what is on screen.
 *
 * ssot-task: T3.1, T3.2
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: { getUserSessionTheme: vi.fn().mockReturnValue('default') },
}));

import { SlackBlockKitChannel } from '../../notification-channels/slack-block-kit-channel';
import type { SessionUsage } from '../../types';
import { ContextHandler } from '../commands/context-handler';
import type { CommandDependencies } from '../commands/types';
import { ThreadHeaderBuilder } from '../thread-header-builder';

/** The state from the reported screenshot: 674,800 of 1,000,000. */
const SCREENSHOT_USAGE: SessionUsage = {
  currentInputTokens: 4_800,
  currentOutputTokens: 5_000,
  currentCacheReadTokens: 640_000,
  currentCacheCreateTokens: 25_000,
  contextWindow: 1_000_000,
  totalInputTokens: 4_800,
  totalOutputTokens: 5_000,
  totalCacheReadTokens: 640_000,
  totalCacheCreateTokens: 25_000,
  totalCostUsd: 0,
  lastUpdated: Date.now(),
};

describe('thread header bar (T3.1, T3.2)', () => {
  it('reports used percent, labelled, with the bar filled to match', () => {
    // 674.8k of 1M is 67.5% used. Three of five segments are filled, which is
    // only coherent if the number beside them is also the used share.
    expect(ThreadHeaderBuilder.formatContextBar(SCREENSHOT_USAGE)).toBe('▓▓▓░░ 674.8k/1M (67.5% used)');
  });

  it('reads consistently at the extremes', () => {
    const nearlyEmpty = { ...SCREENSHOT_USAGE, currentCacheReadTokens: 140_200, currentCacheCreateTokens: 0 };
    // 150k / 1M → 15% used, one segment filled.
    expect(ThreadHeaderBuilder.formatContextBar(nearlyEmpty)).toBe('▓░░░░ 150k/1M (15% used)');

    const full = {
      ...SCREENSHOT_USAGE,
      currentInputTokens: 800_000,
      currentOutputTokens: 200_000,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
    };
    expect(ThreadHeaderBuilder.formatContextBar(full)).toBe('▓▓▓▓▓ 1M/1M (100% used)');
  });
});

describe('/context card (T3.1)', () => {
  it('reports the same used percent as the header, not its complement', async () => {
    const postSystemMessage = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const handler = new ContextHandler({
      claudeHandler: {
        getSession: vi.fn().mockReturnValue({ model: 'claude-fable-5[1m]', usage: SCREENSHOT_USAGE }),
      },
      slackApi: { postSystemMessage },
    } as unknown as CommandDependencies);

    await handler.execute({ channel: 'C1', threadTs: 't1', user: 'U1', text: 'context' } as never);

    const text: string = postSystemMessage.mock.calls[0][1];
    expect(text).toContain('674.8k / 1M (67.5% used)');
    // The old wording is what made the card disagree with the footer.
    expect(text).not.toContain('% available');
  });
});

describe('turn-completion footer (T3.1)', () => {
  it('labels its percent so it cannot be read as the remaining share', async () => {
    const api = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const channel = new SlackBlockKitChannel(api as never);

    await channel.send({
      category: 'WorkflowComplete',
      userId: 'U123',
      channel: 'C123',
      threadTs: '123.456',
      durationMs: 164_000,
      persona: 'default',
      model: 'claude-fable-5[1m]',
      sessionTitle: 'context semantics',
      startedAt: new Date('2026-08-28T11:16:00.000+09:00'),
      // Always the CONSUMED share — see getCurrentContextUsagePercent.
      contextUsagePercent: 67.5,
      contextUsageTokens: 674_800,
      contextWindowSize: 1_000_000,
      contextUsageDelta: -7.7,
    } as never);

    const blocks = api.postMessage.mock.calls[0][2].attachments[0].blocks;
    const allText = blocks
      .map((b: any) => b.elements?.map((e: any) => e.text).join('') ?? b.text?.text ?? '')
      .join('\n');

    expect(allText).toContain('674.8k/1M (67.5% used)');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
