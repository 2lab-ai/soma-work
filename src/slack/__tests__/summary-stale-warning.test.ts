/**
 * #881 D1 — the host's turn-end summary (Path B) raises a new ⚠️ follow-up: the expiry warning posted on the old
 * clock is edited, not left naming an expiry that no longer holds.
 */
import { describe, expect, it, vi } from 'vitest';
import { SummaryService } from '../summary-service';

describe('SummaryService.displayOnThread — a new follow-up edits the stale expiry warning', () => {
  const make = () => {
    const slackApi = {
      postMessage: vi.fn().mockResolvedValue({}),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    return { service: new SummaryService(undefined, slackApi), slackApi };
  };
  const session = (extra: Record<string, unknown> = {}): any => ({
    isActive: true,
    channelId: 'C1',
    warningMessageTs: 'w-1',
    lastWarningSentAt: 600_000,
    actionPanel: {},
    ...extra,
  });

  it('a new ⚠️ reason edits it', () => {
    const { service, slackApi } = make();
    const s = session();
    service.displayOnThread(s, '<tldr>\nPR #7 opened\n⚠️ **PR #7 not merged**\nmerge it\n</tldr>\nbody');
    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C1',
      'w-1',
      expect.stringContaining('세션 만료가 미뤄졌습니다'),
    );
    expect(s.warningMessageTs).toBeUndefined();
  });

  it('the same reason again leaves it', () => {
    const { service, slackApi } = make();
    const s = session({ followUp: { reason: 'PR #7 not merged', at: 1 } });
    service.displayOnThread(s, '<tldr>\nPR #7 opened\n⚠️ **PR #7 not merged**\nmerge it\n</tldr>\nbody');
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(s.warningMessageTs).toBe('w-1');
  });
});
