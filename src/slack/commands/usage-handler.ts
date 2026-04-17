import { Logger } from '../../logger';
import { MetricsEventStore } from '../../metrics/event-store';
import { ReportAggregator } from '../../metrics/report-aggregator';
import type { UsageReport } from '../../metrics/types';
import { isSafeOperational, SlackPostError, SlackUploadError } from '../../metrics/usage-render/errors';
import { renderUsageCard } from '../../metrics/usage-render/renderer';
import type { UsageCardResult } from '../../metrics/usage-render/types';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Injection seam for /usage card pipeline — allows tests to fake out
 * aggregator / renderer / slack-api / clock.
 * Trace: docs/usage-card/trace.md, Scenario 8
 */
export interface UsageCardOverrides {
  aggregator?: { aggregateUsageCard: ReportAggregator['aggregateUsageCard'] };
  renderer?: (stats: Parameters<typeof renderUsageCard>[0]) => Promise<Buffer>;
  slackApi?: {
    filesUploadV2: (args: Record<string, unknown>) => Promise<unknown>;
    postMessage: (args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }) => Promise<unknown>;
    postEphemeral: (args: { channel: string; user: string; text: string; thread_ts?: string }) => Promise<unknown>;
    /** Opens a DM channel with the user and returns the channel id. */
    openDmChannel: (userId: string) => Promise<string>;
  };
  clock?: () => Date;
}

/**
 * Handles /usage command — displays token usage rankings and costs.
 *
 * Privacy: `/usage @someone_else` is rejected. Users can only query their own
 * per-user detail. Aggregate workspace rankings (no @user filter) remain visible
 * to everyone, matching existing dashboard policy.
 *
 * Subcommand `/usage card` renders a personal PNG card (last 30d). Privacy gate
 * applies equally — only the caller's own userId is ever used.
 *
 * Timezone: all date ranges are computed in Asia/Seoul to match
 * ReportAggregator's REPORT_TIMEZONE partitioning.
 */
export class UsageHandler implements CommandHandler {
  private logger = new Logger('UsageHandler');
  private overrides: UsageCardOverrides;

  constructor(
    private deps: CommandDependencies,
    overrides: UsageCardOverrides = {},
  ) {
    this.overrides = overrides;
  }

  canHandle(text: string): boolean {
    return CommandParser.isUsageCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, user } = ctx;

    // Subcommand router: `/usage card` takes a separate path.
    if (isCardSubcommand(text)) {
      return this.handleCard(ctx);
    }

    const parsed = CommandParser.parseUsageCommand(text);

    // Privacy gate: only allow querying your own per-user data.
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
   * Handle `/usage card` — personal 30-day PNG card.
   * Trace: docs/usage-card/trace.md, Scenarios 1, 9, 10, 11, 12
   */
  async handleCard(ctx: CommandContext): Promise<CommandResult> {
    const { channel, threadTs, text, user } = ctx;

    // Strict param gate — v1 spec §3 forbids *any* argument on `/usage card`.
    // `/usage card @someone`, `/usage card foo` → reject explicitly rather
    // than silently produce the caller's own card.
    if (hasExtraCardArgs(text)) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '⚠️ `/usage card` 는 추가 인자를 받지 않습니다. 본인 카드만 발급 가능합니다.',
        { threadTs },
      );
      return { handled: true };
    }

    const parsed = CommandParser.parseUsageCommand(text);

    // Privacy gate — redundant safety net (strict param gate above should
    // already catch this). Kept so the privacy rule can never regress even
    // if the parser grows new cases.
    if (parsed.userId && parsed.userId !== user) {
      await this.deps.slackApi.postSystemMessage(
        channel,
        '⚠️ 다른 사용자의 사용량 카드는 조회할 수 없습니다. 본인 카드만 발급 가능합니다.',
        { threadTs },
      );
      return { handled: true };
    }

    const clock = this.overrides.clock ?? (() => new Date());
    const now = clock();
    const { startDate, endDate } = this.getDateRange(now, 'month');

    const store = new MetricsEventStore();
    const defaultAggregator = new ReportAggregator(store);
    const aggregator = this.overrides.aggregator ?? defaultAggregator;

    const stats: UsageCardResult = await aggregator.aggregateUsageCard({
      startDate,
      endDate,
      targetUserId: user,
      topN: 10,
      now,
    });

    if (stats.empty) {
      await this.postEphemeral(ctx, '최근 30일간 기록된 사용량이 없습니다. `/usage`로 기본 집계를 먼저 확인하세요.');
      return { handled: true };
    }

    try {
      const renderer = this.overrides.renderer ?? renderUsageCard;
      const png = await renderer(stats);

      let fileId: string | undefined;
      try {
        const uploadArgs = {
          filename: 'usage-card.png',
          file: png,
          channel_id: channel,
          alt_text: `Usage card for ${stats.targetUserName || stats.targetUserId}`,
          request_file_info: false,
        };
        const uploadResp = this.overrides.slackApi
          ? await this.overrides.slackApi.filesUploadV2(uploadArgs)
          : await this.deps.slackApi.getClient().filesUploadV2(uploadArgs);
        fileId = extractFileId(uploadResp);
      } catch (err) {
        throw new SlackUploadError('filesUploadV2 failed', err);
      }

      // Post Block Kit image block referencing the uploaded file.
      const altText = `${stats.targetUserName || stats.targetUserId} — Usage Card (${stats.windowStart} ~ ${stats.windowEnd})`;
      const blocks = fileId ? [{ type: 'image', slack_file: { id: fileId }, alt_text: altText }] : undefined;

      try {
        if (this.overrides.slackApi) {
          await this.overrides.slackApi.postMessage({
            channel,
            text: altText,
            blocks,
            thread_ts: threadTs,
          });
        } else if (blocks) {
          await this.deps.slackApi.postMessage(channel, altText, { threadTs, blocks });
        } else {
          // filesUploadV2 returned no file id — file is still attached to the channel.
          await this.deps.slackApi.postSystemMessage(channel, altText, { threadTs });
        }
      } catch (err) {
        throw new SlackPostError('chat.postMessage failed', err);
      }

      this.logger.info('usage_card_rendered', {
        userId: user,
        pngBytes: png.byteLength,
      });
      return { handled: true };
    } catch (err) {
      if (isSafeOperational(err)) {
        const kind = err.constructor.name;
        this.logger.error('usage_card_safe_failure', {
          kind,
          message: err.message,
        });
        await this.postEphemeral(ctx, '카드 생성 실패, 잠시 후 다시 시도해 주세요.');
        // Best-effort DM alert (spec §4.4 / §5 acceptance §4). Failure of the
        // DM itself is swallowed — the channel fallback already succeeded and
        // a secondary failure must not mask the first.
        await this.postDmAlert(user, kind);
        return { handled: true };
      }
      // Non-operational error: re-throw so upstream handler/logging sees it.
      throw err;
    }
  }

  /**
   * Notify the caller via DM that their `/usage card` render failed.
   * Errors are logged but never thrown — this is an auxiliary alert path.
   */
  private async postDmAlert(userId: string, kind: string): Promise<void> {
    const text = `⚠️ 사용량 카드 생성 실패 (\`${kind}\`). 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.`;
    try {
      if (this.overrides.slackApi) {
        const dmChannel = await this.overrides.slackApi.openDmChannel(userId);
        await this.overrides.slackApi.postMessage({ channel: dmChannel, text });
        return;
      }
      const dmChannel = await this.deps.slackApi.openDmChannel(userId);
      await this.deps.slackApi.postMessage(dmChannel, text);
    } catch (dmErr) {
      this.logger.error('usage_card_dm_alert_failed', {
        kind,
        message: dmErr instanceof Error ? dmErr.message : String(dmErr),
      });
    }
  }

  private async postEphemeral(ctx: CommandContext, text: string): Promise<void> {
    const { channel, threadTs, user } = ctx;
    if (this.overrides.slackApi) {
      await this.overrides.slackApi.postEphemeral({ channel, user, text, thread_ts: threadTs });
      return;
    }
    await this.deps.slackApi.postEphemeral(channel, user, text, threadTs);
  }

  /**
   * Compute [startDate, endDate] date strings in Asia/Seoul timezone.
   */
  private getDateRange(now: Date, period: 'today' | 'week' | 'month'): { startDate: string; endDate: string } {
    const fmtKst = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const endDate = fmtKst.format(now);
    const daysBack = period === 'week' ? 6 : period === 'month' ? 29 : 0;
    if (daysBack === 0) {
      return { startDate: endDate, endDate };
    }
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

    const t = report.totals;
    lines.push('*전체 사용량:*');
    lines.push(`  • 입력: ${this.fmt(t.totalInputTokens)} tokens`);
    lines.push(`  • 출력: ${this.fmt(t.totalOutputTokens)} tokens`);
    lines.push(`  • 캐시 읽기: ${this.fmt(t.totalCacheReadTokens)} tokens`);
    lines.push(`  • 캐시 생성: ${this.fmt(t.totalCacheCreateTokens)} tokens`);
    lines.push(`  • 비용: $${t.totalCostUsd.toFixed(4)}`);

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

/**
 * Detect `/usage card` (optional leading slash, optional trailing tokens).
 * Routing-level check: returns true even when extra tokens are present so the
 * handler can produce an explicit reject message instead of silently falling
 * through to the bare `/usage` path. Strict arg-count enforcement lives in
 * `hasExtraCardArgs` below.
 */
export function isCardSubcommand(text: string): boolean {
  const trimmed = text.trim().replace(/^\//, '');
  const parts = trimmed.split(/\s+/);
  if (parts[0]?.toLowerCase() !== 'usage') return false;
  return (parts[1] ?? '').toLowerCase() === 'card';
}

/**
 * Returns true if `/usage card` was invoked with any extra tokens
 * (e.g. `/usage card @someone`, `/usage card foo`). Spec §3 forbids args.
 */
export function hasExtraCardArgs(text: string): boolean {
  const trimmed = text.trim().replace(/^\//, '');
  const parts = trimmed.split(/\s+/).filter((p) => p.length > 0);
  // Expected shape: ['usage', 'card']; anything longer is a violation.
  return parts.length > 2;
}

interface FilesUploadV2RespFileInner {
  id?: string;
}
interface FilesUploadV2RespFile {
  id?: string;
  files?: FilesUploadV2RespFileInner[];
}
interface FilesUploadV2Resp {
  files?: FilesUploadV2RespFile[];
}

function extractFileId(resp: unknown): string | undefined {
  if (!resp || typeof resp !== 'object') return undefined;
  const r = resp as FilesUploadV2Resp;
  // @slack/web-api v7 filesUploadV2 shape: { files: [{ files: [{ id }] }] }
  const first = r.files?.[0];
  const inner: FilesUploadV2RespFileInner | FilesUploadV2RespFile | undefined = first?.files?.[0] ?? first;
  return inner?.id;
}
