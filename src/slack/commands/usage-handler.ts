import { ReportAggregator } from '../../metrics/report-aggregator';
import { MetricsEventStore } from '../../metrics/event-store';
import type { TokenUsageRanking, UsageReport } from '../../metrics/types';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles /usage command — displays token usage rankings and costs.
 */
export class UsageHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isUsageCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, user } = ctx;
    const parsed = CommandParser.parseUsageCommand(text);

    const now = new Date();
    const { startDate, endDate } = this.getDateRange(now, parsed.period);

    const store = new MetricsEventStore();
    const aggregator = new ReportAggregator(store);
    const report = await aggregator.aggregateTokenUsage(startDate, endDate, parsed.userId || undefined);

    const message = this.formatReport(report, parsed.period, parsed.userId);
    await this.deps.slackApi.postSystemMessage(channel, message, { threadTs });

    return { handled: true };
  }

  private getDateRange(now: Date, period: 'today' | 'week' | 'month'): { startDate: string; endDate: string } {
    const endDate = now.toISOString().slice(0, 10);
    let startDate: string;
    switch (period) {
      case 'week': {
        const d = new Date(now);
        d.setDate(d.getDate() - 6);
        startDate = d.toISOString().slice(0, 10);
        break;
      }
      case 'month': {
        const d = new Date(now);
        d.setDate(d.getDate() - 29);
        startDate = d.toISOString().slice(0, 10);
        break;
      }
      default:
        startDate = endDate;
    }
    return { startDate, endDate };
  }

  private formatReport(report: UsageReport, period: string, userId?: string): string {
    const periodLabel = period === 'today' ? '오늘' : period === 'week' ? '이번 주' : '이번 달';
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
