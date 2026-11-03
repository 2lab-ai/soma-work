/**
 * #835 — `report leaks`: the link leak report for the last 24 hours, in the thread, now.
 *
 *   L1  `report leaks` runs the reporter and replies with its message
 *   L2  when the report is off (no channel) or GitHub could not be read, it says so
 */
import { describe, expect, it, vi } from 'vitest';
import { ReportHandler } from '../../slack/commands/report-handler';

const base = {
  aggregator: { aggregateDaily: vi.fn(), aggregateWeekly: vi.fn() },
  formatter: { formatDaily: vi.fn(), formatWeekly: vi.fn() },
};

describe('ReportHandler — report leaks (#835)', () => {
  it('L1 — runs the reporter and replies in the thread', async () => {
    const say = vi.fn().mockResolvedValue(undefined);
    const runNow = vi.fn().mockResolvedValue({ text: 'leak: 1 of 2', blocks: [{ type: 'section' }] });
    const handler = new ReportHandler({ ...base, linkLeak: { runNow } } as any);
    expect(handler.canHandle('report leaks')).toBe(true);
    const result = await handler.execute({ text: 'report leaks', say, threadTs: 'T1', user: 'U1' } as any);
    expect(result.handled).toBe(true);
    expect(runNow).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith({ text: 'leak: 1 of 2', blocks: [{ type: 'section' }], thread_ts: 'T1' });
    expect(base.aggregator.aggregateDaily).not.toHaveBeenCalled();
  });

  it('L2 — off or unreadable: says so', async () => {
    const say = vi.fn().mockResolvedValue(undefined);
    const handler = new ReportHandler({ ...base, linkLeak: { runNow: vi.fn().mockResolvedValue(undefined) } } as any);
    await handler.execute({ text: 'report leaks', say, threadTs: 'T1', user: 'U1' } as any);
    expect(say.mock.calls[0][0].text).toContain('SOMA_LINK_LEAK_REPORT_CHANNEL');
    const bare = new ReportHandler(base as any);
    await bare.execute({ text: 'report leaks', say, threadTs: 'T2', user: 'U1' } as any);
    expect(say.mock.calls[1][0].text).toContain('SOMA_LINK_LEAK_REPORT_CHANNEL');
  });
});
