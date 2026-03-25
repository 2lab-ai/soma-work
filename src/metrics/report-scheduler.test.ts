import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ReportScheduler } from './report-scheduler';

// Contract tests — Scenario 6: ReportScheduler + ReportHandler
// Trace: docs/daily-weekly-report/trace.md

describe('ReportScheduler', () => {
  let scheduler: ReportScheduler;
  let mockAggregator: any;
  let mockFormatter: any;
  let mockPublisher: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockAggregator = {
      aggregateDaily: vi.fn().mockResolvedValue({
        date: '2026-03-25', period: 'daily', metrics: {},
      }),
      aggregateWeekly: vi.fn().mockResolvedValue({
        weekStart: '2026-03-23', weekEnd: '2026-03-29', period: 'weekly', metrics: {}, rankings: [],
      }),
    };
    mockFormatter = {
      formatDaily: vi.fn().mockReturnValue({ blocks: [], text: 'daily report' }),
      formatWeekly: vi.fn().mockReturnValue({ blocks: [], text: 'weekly report' }),
    };
    mockPublisher = {
      publish: vi.fn().mockResolvedValue({ ts: '123.456' }),
    };
    scheduler = new ReportScheduler(
      mockAggregator, mockFormatter, mockPublisher,
      { channelId: 'C123', timezone: 'Asia/Seoul', dailyHour: 0, weeklyDay: 1, weeklyHour: 9 }
    );
    // Reset schedule state to avoid cross-test contamination from disk file
    scheduler.setScheduleState({});
  });

  afterEach(() => {
    vi.useRealTimers();
    scheduler.stop();
  });

  // Trace: Scenario 6, Section 3b — daily trigger at configured time
  it('dailyTrigger_atConfiguredTime', async () => {
    // Set time to 00:00 KST (15:00 UTC previous day)
    vi.setSystemTime(new Date('2026-03-25T15:00:00Z'));

    await scheduler.checkAndRun();

    expect(mockAggregator.aggregateDaily).toHaveBeenCalledWith('2026-03-25');
    expect(mockPublisher.publish).toHaveBeenCalled();
  });

  // Trace: Scenario 6, Section 3b — weekly trigger at configured time
  it('weeklyTrigger_atConfiguredTime', async () => {
    // Monday 09:00 KST = Monday 00:00 UTC
    vi.setSystemTime(new Date('2026-03-23T00:00:00Z')); // Monday

    await scheduler.checkAndRun();

    expect(mockAggregator.aggregateWeekly).toHaveBeenCalled();
    expect(mockPublisher.publish).toHaveBeenCalled();
  });

  // Trace: Scenario 6, Section 3b — skips duplicate same day
  it('skipsDuplicate_sameDay', async () => {
    vi.setSystemTime(new Date('2026-03-25T15:00:00Z'));

    await scheduler.checkAndRun();
    await scheduler.checkAndRun(); // Second run same minute

    // Should only trigger once
    expect(mockAggregator.aggregateDaily).toHaveBeenCalledTimes(1);
  });

  // Trace: Scenario 6, Section 5 — corrupted state resets gracefully
  it('corruptedState_resetsGracefully', async () => {
    // Simulate corrupted state by setting invalid internal state
    scheduler.setScheduleState({ lastDailyDate: undefined as any, lastWeeklyDate: undefined as any });

    vi.setSystemTime(new Date('2026-03-25T15:00:00Z'));

    // Should not throw
    await expect(scheduler.checkAndRun()).resolves.not.toThrow();
  });
});
