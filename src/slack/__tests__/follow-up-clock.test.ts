import { describe, expect, it } from 'vitest';
import { applyFollowUp } from '../summary-service';

/**
 * #846 (trinity R1 on #874) — the follow-up is one fact with one start time.
 *
 * The idle clock restarts at `followUp.at` (item 5). A summary that repeats the same ⚠️ reason is the same follow-up:
 * it keeps its time, so re-running es on an unfinished artifact cannot push sleep out forever, and the panel does not
 * announce it again. A new reason starts now and clears the sleep warnings sent on the old clock (they named the old
 * expiry, and a sent warning is never sent again until cleared).
 */

const WARN = (reason: string) => ['done', `⚠️ **${reason}**`, 'next'];

describe('applyFollowUp', () => {
  it('a new follow-up starts now and clears the sleep warnings of the old clock', () => {
    const s: any = { lastWarningSentAt: 12 * 3600_000, warningMessageTs: '1.2' };
    applyFollowUp(s, WARN('PR #1 open'), 1000);
    expect(s.followUp).toEqual({ reason: 'PR #1 open', at: 1000 });
    expect(s.lastWarningSentAt).toBeUndefined();
    expect(s.warningMessageTs).toBeUndefined();
  });

  it('the same reason again keeps its time and the warning state', () => {
    const s: any = {
      followUp: { reason: 'PR #1 open', at: 1000 },
      lastWarningSentAt: 600_000,
      warningMessageTs: '1.3',
    };
    applyFollowUp(s, WARN('PR #1 open'), 9000);
    expect(s.followUp).toEqual({ reason: 'PR #1 open', at: 1000 });
    expect(s.lastWarningSentAt).toBe(600_000);
    expect(s.warningMessageTs).toBe('1.3');
  });

  it('a different reason is a new follow-up', () => {
    const s: any = { followUp: { reason: 'PR #1 open', at: 1000 }, lastWarningSentAt: 600_000 };
    applyFollowUp(s, WARN('PR #2 draft'), 9000);
    expect(s.followUp).toEqual({ reason: 'PR #2 draft', at: 9000 });
    expect(s.lastWarningSentAt).toBeUndefined();
  });

  it('no ⚠️ line clears it', () => {
    const s: any = { followUp: { reason: 'PR #1 open', at: 1000 } };
    applyFollowUp(s, ['all merged', 'nothing left', 'done'], 9000);
    expect(s.followUp).toBeUndefined();
  });
});
