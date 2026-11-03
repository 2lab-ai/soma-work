/**
 * #881 D1 — the host's turn-end summary (Path B) raises a new ⚠️ follow-up: the expiry warning posted on the old
 * clock is edited, not left naming an expiry that no longer holds. Path B goes through the same live-root gate as the
 * registry path (astra · fable · grok R1 P2): the host hands in the editor; SummaryService never calls chat.update.
 */
import { describe, expect, it, vi } from 'vitest';
import { SummaryService } from '../summary-service';

describe('SummaryService.displayOnThread — a new follow-up edits the stale expiry warning', () => {
  const make = () => {
    const onWarningCleared = vi.fn();
    const slackApi = { postMessage: vi.fn().mockResolvedValue({}) };
    return { service: new SummaryService(undefined, slackApi, { onWarningCleared }), onWarningCleared };
  };
  const session = (extra: Record<string, unknown> = {}): any => ({
    isActive: true,
    channelId: 'C1',
    warningMessageTs: 'w-1',
    lastWarningSentAt: 600_000,
    actionPanel: {},
    ...extra,
  });

  it('a new ⚠️ reason hands the stale warning to the host', () => {
    const { service, onWarningCleared } = make();
    const s = session();
    service.displayOnThread(s, '<tldr>\nPR #7 opened\n⚠️ **PR #7 not merged**\nmerge it\n</tldr>\nbody');
    expect(onWarningCleared).toHaveBeenCalledWith(s, 'w-1');
    expect(s.warningMessageTs).toBeUndefined();
  });

  it('the same reason again leaves it', () => {
    const { service, onWarningCleared } = make();
    const s = session({ followUp: { reason: 'PR #7 not merged', at: 1 } });
    service.displayOnThread(s, '<tldr>\nPR #7 opened\n⚠️ **PR #7 not merged**\nmerge it\n</tldr>\nbody');
    expect(onWarningCleared).not.toHaveBeenCalled();
    expect(s.warningMessageTs).toBe('w-1');
  });
});
