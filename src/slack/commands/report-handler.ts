/**
 * ReportHandler — Slash command handler for report commands.
 *
 * `report`       — 오늘 실시간 리포트 (기본값)
 * `report today`  — 오늘 실시간 리포트
 * `report daily`  — 전일 일간 리포트
 * `report weekly` — 전주 주간 리포트 (사용자별 랭킹 포함)
 * `report help`   — 도움말
 *
 * Trace: docs/daily-weekly-report/trace.md, Scenario 6
 */

import { CommandHandler, CommandContext, CommandResult } from './types';
import { Logger } from '../../logger';

const logger = new Logger('ReportHandler');

// Minimal interfaces to avoid tight coupling
interface AggregatorLike {
  aggregateDaily(date: string): Promise<any>;
  aggregateWeekly(weekStart: string): Promise<any>;
}

interface FormatterLike {
  formatDaily(report: any): { blocks: any[]; text: string };
  formatWeekly(report: any): { blocks: any[]; text: string };
}

interface ReportDeps {
  aggregator: AggregatorLike;
  formatter: FormatterLike;
}

const REPORT_COMMAND_REGEX = /^report(?:\s+(today|daily|weekly|help))?$/i;

const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Seoul';

/**
 * Get today's date string in configured timezone (YYYY-MM-DD).
 */
function getTodayInTimezone(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Get yesterday's date as YYYY-MM-DD in configured timezone.
 */
function getYesterdayDateStr(): string {
  const today = getTodayInTimezone();
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Get last Monday's date as YYYY-MM-DD in configured timezone.
 */
function getLastMondayDateStr(): string {
  const today = getTodayInTimezone();
  const d = new Date(today + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay();
  const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  d.setUTCDate(d.getUTCDate() - daysToLastMonday - 7);
  return d.toISOString().slice(0, 10);
}

const HELP_TEXT = [
  '*:bar_chart: 리포트 명령어*',
  '',
  '`report` — 오늘 실시간 리포트 (기본값)',
  '`report today` — 오늘 실시간 리포트',
  '`report daily` — 전일 일간 리포트',
  '`report weekly` — 전주 주간 리포트 (사용자별 랭킹 포함)',
  '`report help` — 이 도움말',
].join('\n');

export class ReportHandler implements CommandHandler {
  private deps: ReportDeps;

  constructor(deps: ReportDeps) {
    this.deps = deps;
  }

  canHandle(text: string): boolean {
    return REPORT_COMMAND_REGEX.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, say, threadTs, user } = ctx;
    const match = text.trim().match(REPORT_COMMAND_REGEX);

    if (!match) {
      return { handled: false };
    }

    const subcommand = (match[1] || 'today').toLowerCase();

    if (subcommand === 'help') {
      await say({ text: HELP_TEXT, thread_ts: threadTs });
      return { handled: true };
    }

    logger.info(`Manual ${subcommand} report triggered by ${user}`);

    try {
      let formatted: { blocks: any[]; text: string };

      if (subcommand === 'today') {
        formatted = this.deps.formatter.formatDaily(
          await this.deps.aggregator.aggregateDaily(getTodayInTimezone()),
        );
      } else if (subcommand === 'daily') {
        formatted = this.deps.formatter.formatDaily(
          await this.deps.aggregator.aggregateDaily(getYesterdayDateStr()),
        );
      } else {
        formatted = this.deps.formatter.formatWeekly(
          await this.deps.aggregator.aggregateWeekly(getLastMondayDateStr()),
        );
      }

      await say({ text: formatted.text, blocks: formatted.blocks, thread_ts: threadTs });
    } catch (error) {
      logger.error(`Failed to generate ${subcommand} report`, error);
      await say({ text: `:x: 리포트 생성 실패: ${(error as Error).message}`, thread_ts: threadTs });
    }

    return { handled: true };
  }
}
