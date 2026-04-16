import { MetricsEventStore } from '../../metrics/event-store';
import { ReportAggregator } from '../../metrics/report-aggregator';
import type { TokenUsageRanking, UsageReport } from '../../metrics/types';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles /usage command — displays token usage rankings and costs.
 *
 * Privacy: `/usage @someone_else` is rejected. Users can only query their own
 * per-user detail. Aggregate workspace rankings (no @user filter) remain visible
 * to everyone, matching existing dashboard policy.
 *
 * Timezone: all date ranges are computed in Asia/Seoul to match
 * ReportAggregator's REPORT_TIMEZONE partitioning. Using UTC here caused
 * off-by-one-day bugs from 00:00-08:59 KST (where KST date and UTC date differ).
 */
export class UsageHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isUsageCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, user } = ctx;
    const parsed = CommandParser.parseUsageCommand(text);

    // Privacy gate: only allow querying your own per-user data.
    // Without this, any workspace user could read another's token usage + cost.
    if (parsed.userId && parsed.userId !== user) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '⚠️ 다른 사용자의 토큰 사용량은 조회할 수 없습니다. 본인의 사용량만 확인 가능합니다.',
        { threadTs },
      );
      return { handled: true };
    }

    const now = new Date();
    const { startDate, endDate } = this.getDateRange(now, parsed.period);

    const store = new MetricsEventStore();
    const aggregator = new ReportAggregator(store);
    const report = await aggregator.aggregateTokenUsage(startDate, endDate, parsed.userId || undefined);

    const message = this.formatReport(report, parsed.period, parsed.userId);
    await this.deps.slackApi.postSystemMessage(channel, message, { threadTs });

    return { handled: true };
  }

  /**
   * Compute [startDate, endDate] date strings in Asia/Seoul timezone.
   * Must match ReportAggregator's REPORT_TIMEZONE (Asia/Seoul) to avoid
   * querying the wrong day from 00:00-08:59 KST.
   *
   * Windows are rolling: week = today & previous 6 days, month = today
   * & previous 29 days. Calendar-aligned windows are deferred to a
   * follow-up issue.
   */
  private getDateRange(now: Date, period: 'today' | 'week' | 'month'): { startDate: string; endDate: string } {
    const fmtKst = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const endDate = fmtKst.format(now); // YYYY-MM-DD in KST
    const daysBack = period === 'week' ? 6 : period === 'month' ? 29 : 0;
    if (daysBack === 0) {
      return { startDate: endDate, endDate };
    }
    // Subtract `daysBack` days using UTC-midnight arithmetic on the KST date string.
    // Safe because we only need a day count — no actual TZ conversion involved.
    const [y, m, d] = endDate.split('-').map(Number);
    const startMs = Date.UTC(y, m - 1, d) - daysBack * 86_400_000;
    const start = new Date(startMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const startDate = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
    return { startDate, endDate };
  }

  private formatReport(report: UsageReport, period: string, userId?: string): string {
    const periodLabel = period === 'today' ? '오늘' : period === 'week' ? '최근 7일' : '최근 30일';
    const lines: string[] = [`📊 *토큰 사용량* — ${periodLabel}`, ''];

    // Totals
    const t = report.totals;
    lines.push('*전체 사용량:*');
    lines.push(`  • 입력: ${this.fmt(t.totalInputTokens)} tokens`);
    lines.push(`  • 출력: ${this.fmt(t.totalOutputTokens)} tokens`);
    lines.push(`  • 캐시 읽기: ${this.fmt(t.totalCacheReadTokens)} tokens`);
    lines.push(`  • 캐시 생성: ${this.fmt(t.totalCacheCreateTokens)} tokens`);
    lines.push(`  • 비용: $${t.totalCostUsd.toFixed(4)}`);

    // Rankings (only when not filtered by user)
    if (!userId && report.tokenRankings && report.tokenRankings.length > 0) {
      lines.push('');
      lines.push('*🏆 토큰 사용 랭킹:*');
      for (const r of report.tokenRankings.slice(0, 10)) {
        const medal = r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `${r.rank}.`;
        lines.push(`  ${medal} ${r.userName} — ${this.fmt(r.totalTokens)} tokens`);
      }

      lines.push('');
      lines.push('*💰 비용 랭킹:*');
      for (const r of (report.costRankings || []).slice(0, 10)) {
        const medal = r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `${r.rank}.`;
        lines.push(`  ${medal} ${r.userName} — $${r.totalCostUsd.toFixed(4)}`);
      }
    }

    if (report.hasLegacyData) {
      lines.push('');
      lines.push('_⚠️ 일부 데이터는 이전 가격 체계로 기록되었습니다._');
    }

    return lines.join('\n');
  }

  private fmt(n: number): string {
    return n.toLocaleString();
  }
}
