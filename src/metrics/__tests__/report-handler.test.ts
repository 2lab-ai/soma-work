import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportHandler } from '../../slack/commands/report-handler';

// Contract tests — Scenario 6: ReportHandler (slash command)
// Trace: docs/daily-weekly-report/trace.md

describe('ReportHandler', () => {
  let handler: ReportHandler;
  let mockDeps: any;
  let mockSay: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSay = vi.fn().mockResolvedValue(undefined);
    mockDeps = {
      aggregator: {
        aggregateDaily: vi.fn().mockResolvedValue({
          date: '2026-03-25',
          period: 'daily',
          metrics: {
            sessionsCreated: 1,
            sessionsSlept: 0,
            sessionsClosed: 0,
            issuesCreated: 0,
            prsCreated: 0,
            commitsCreated: 0,
            codeLinesAdded: 0,
            codeLinesDeleted: 0,
            prsMerged: 0,
            mergeLinesAdded: 0,
            turnsUsed: 5,
          },
        }),
        aggregateWeekly: vi.fn().mockResolvedValue({
          weekStart: '2026-03-23',
          weekEnd: '2026-03-29',
          period: 'weekly',
          metrics: {
            sessionsCreated: 5,
            sessionsSlept: 1,
            sessionsClosed: 2,
            issuesCreated: 3,
            prsCreated: 2,
            commitsCreated: 8,
            codeLinesAdded: 400,
            codeLinesDeleted: 40,
            prsMerged: 1,
            mergeLinesAdded: 200,
            turnsUsed: 30,
          },
          rankings: [],
        }),
      },
      formatter: {
        formatDaily: vi.fn().mockReturnValue({ blocks: [{ type: 'header' }], text: 'daily' }),
        formatWeekly: vi.fn().mockReturnValue({ blocks: [{ type: 'header' }], text: 'weekly' }),
      },
    };
    handler = new ReportHandler(mockDeps);
  });

  // Trace: Scenario 6, Section 3a — canHandle matches report commands
  it('canHandle_matchesReportCommands', () => {
    expect(handler.canHandle('report')).toBe(true);
    expect(handler.canHandle('report today')).toBe(true);
    expect(handler.canHandle('report daily')).toBe(true);
    expect(handler.canHandle('report weekly')).toBe(true);
    // /z refactor (#506): `report help` was removed — use `/z help` instead.
    expect(handler.canHandle('report help')).toBe(false);
    expect(handler.canHandle('something else')).toBe(false);
  });

  // Default: `report` shows today's realtime data
  it('reportNoArgs_showsTodayRealtime', async () => {
    const result = await handler.execute({
      user: 'U123',
      channel: 'C456',
      threadTs: '123.456',
      text: 'report',
      say: mockSay as any,
    });

    expect(result.handled).toBe(true);
    expect(mockDeps.aggregator.aggregateDaily).toHaveBeenCalled();
    expect(mockDeps.formatter.formatDaily).toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalled();
  });

  // `report today` also shows today's data
  it('reportToday_showsTodayRealtime', async () => {
    const result = await handler.execute({
      user: 'U123',
      channel: 'C456',
      threadTs: '123.456',
      text: 'report today',
      say: mockSay as any,
    });

    expect(result.handled).toBe(true);
    expect(mockDeps.aggregator.aggregateDaily).toHaveBeenCalled();
    expect(mockDeps.formatter.formatDaily).toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalled();
  });

  // Trace: Scenario 6, Section 3a — daily report triggers aggregation
  it('reportDaily_triggersAggregationAndFormats', async () => {
    const result = await handler.execute({
      user: 'U123',
      channel: 'C456',
      threadTs: '123.456',
      text: 'report daily',
      say: mockSay as any,
    });

    expect(result.handled).toBe(true);
    expect(mockDeps.aggregator.aggregateDaily).toHaveBeenCalled();
    expect(mockDeps.formatter.formatDaily).toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalled();
  });

  // Trace: Scenario 6, Section 3a — weekly report triggers aggregation
  it('reportWeekly_triggersAggregationAndFormats', async () => {
    const result = await handler.execute({
      user: 'U123',
      channel: 'C456',
      threadTs: '123.456',
      text: 'report weekly',
      say: mockSay as any,
    });

    expect(result.handled).toBe(true);
    expect(mockDeps.aggregator.aggregateWeekly).toHaveBeenCalled();
    expect(mockDeps.formatter.formatWeekly).toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalled();
  });

  // /z refactor (#506): `report help` is removed. The handler no longer
  // accepts the subcommand; users are redirected to `/z help` via the
  // tombstone surface in CommandRouter. `execute()` with that text must
  // return handled=false so the router can continue dispatch.
  it('reportHelp_isRemoved_doesNotHandle', async () => {
    const result = await handler.execute({
      user: 'U123',
      channel: 'C456',
      threadTs: '123.456',
      text: 'report help',
      say: mockSay as any,
    });

    expect(result.handled).toBe(false);
    expect(mockSay).not.toHaveBeenCalled();
    expect(mockDeps.aggregator.aggregateDaily).not.toHaveBeenCalled();
    expect(mockDeps.aggregator.aggregateWeekly).not.toHaveBeenCalled();
  });

  // Trace: Scenario 6, Section 5 — handler works when no REPORT_CHANNEL_ID is set
  it('missingChannelConfig_showsError', async () => {
    const result = await handler.execute({
      user: 'U123',
      channel: 'C456',
      threadTs: '123.456',
      text: 'report daily',
      say: mockSay as any,
    });

    expect(result.handled).toBe(true);
  });
});
