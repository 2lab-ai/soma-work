import { Logger } from '../../logger';
import { MetricsEventStore } from '../../metrics/event-store';
import { ReportAggregator } from '../../metrics/report-aggregator';
import type { UsageReport } from '../../metrics/types';
import { renderCarousel as defaultRenderCarousel } from '../../metrics/usage-render/carousel-renderer';
import { isSafeOperational, SlackPostError, SlackUploadError } from '../../metrics/usage-render/errors';
import type { CarouselStats, TabId } from '../../metrics/usage-render/types';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';
import { buildCarouselBlocks } from './usage-carousel-blocks';
import { defaultTabCache, type TabCache } from './usage-carousel-cache';

/**
 * Injection seam for /usage card pipeline — allows tests to fake out
 * aggregator / renderer / slack-api / clock.
 * Trace: docs/usage-card-dark/trace.md, Scenario 1.
 */
export interface UsageCardOverrides {
  aggregator?: {
    aggregateCarousel: ReportAggregator['aggregateCarousel'];
  };
  /** Carousel SSR renderer. */
  renderCarousel?: (stats: CarouselStats, selectedTab: TabId) => Promise<Record<TabId, Buffer>>;
  slackApi?: {
    filesUploadV2: (args: Record<string, unknown>) => Promise<unknown>;
    postMessage: (args: {
      channel: string;
      text: string;
      blocks?: unknown[];
      thread_ts?: string;
    }) => Promise<{ ts: string } | unknown>;
    postEphemeral: (args: { channel: string; user: string; text: string; thread_ts?: string }) => Promise<unknown>;
    /** Opens a DM channel with the user and returns the channel id. */
    openDmChannel: (userId: string) => Promise<string>;
  };
  clock?: () => Date;
  /** TabCache DI — defaults to the module-singleton `defaultTabCache`. */
  tabCache?: TabCache;
}

// ─── Cold-cache retry sleep (DI for tests) ──────────────────────────────
// `postMessage` with a freshly-uploaded `slack_file.id` can race Slack's
// internal file propagation and fail with `invalid_blocks`. We retry up to
// 3× with 500ms spacing. `sleepImpl` is swappable by tests so fake timers
// (or an instant-return stub) can drive the loop without real wall time.
let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test-only: replace the retry sleep (call with `null` to reset). */
export function __setSleepImplForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
 * Timezone: `week` and `month` date ranges are computed in Asia/Seoul to match
 * ReportAggregator's REPORT_TIMEZONE partitioning. The default path
 * (`period === 'today'`) is a rolling 24h window `[now - 24h, now]` in
 * absolute ms — the KST day-files are still the read unit, but the filter
 * is timestamp-based. See issue #650.
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
    const store = new MetricsEventStore();
    const aggregator = new ReportAggregator(store);

    // `/usage` (period === 'today') now shows a rolling 24h window
    // [now - 24h, now] instead of the KST calendar day. `/usage week` and
    // `/usage month` keep their calendar-range semantics.
    // Issue: https://github.com/2lab-ai/soma-work/issues/650
    let report: UsageReport;
    if (parsed.period === 'today') {
      const nowMs = now.getTime();
      const startMs = nowMs - 24 * 60 * 60 * 1000;
      report = await aggregator.aggregateTokenUsageMs(startMs, nowMs, parsed.userId || undefined);
    } else {
      const { startDate, endDate } = this.getDateRange(now, parsed.period);
      report = await aggregator.aggregateTokenUsage(startDate, endDate, parsed.userId || undefined);
    }

    const message = this.formatReport(report, parsed.period, parsed.userId);
    await this.deps.slackApi.postSystemMessage(channel, message, { threadTs });

    return { handled: true };
  }

  /**
   * Handle `/usage card` — personal 4-tab carousel (24h / 7d / 30d / all).
   * Trace: docs/usage-card-dark/trace.md, Scenario 1 (+ 9 privacy, 12 all-empty, 13 errors, 15 regression).
   */
  async handleCard(ctx: CommandContext): Promise<CommandResult> {
    const { channel, text, threadTs, user } = ctx;

    // Strict param gate — spec §3 forbids *any* argument on `/usage card`.
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

    try {
      // Aggregator DI — fall back to real `aggregateCarousel` on a fresh store.
      const aggregateCarousel =
        this.overrides.aggregator?.aggregateCarousel ??
        (async (opts: Parameters<ReportAggregator['aggregateCarousel']>[0]) => {
          const store = new MetricsEventStore();
          const agg = new ReportAggregator(store);
          return agg.aggregateCarousel(opts);
        });

      const carouselStats = await aggregateCarousel({ targetUserId: user, now });

      // All-empty short-circuit (Scenario 12) — no events in any window at all.
      const tabIds: readonly TabId[] = ['24h', '7d', '30d', 'all'] as const;
      const allEmpty = tabIds.every((t) => carouselStats.tabs[t].empty === true);
      if (allEmpty) {
        this.logger.info('carousel_all_empty', { userId: user });
        await this.postEphemeral(ctx, '최근 30일간 기록된 사용량이 없습니다. `/usage` 로 기본 집계를 먼저 확인하세요.');
        return { handled: true };
      }

      // Render 4 tab PNGs in parallel (renderer handles stub PNGs for empty tabs).
      const renderCarousel = this.overrides.renderCarousel ?? defaultRenderCarousel;
      const pngMap = await renderCarousel(carouselStats, '30d');

      // Upload 4 PNGs — NO `channel_id` / `channels` / `thread_ts` / `initial_comment`
      // so Slack does NOT auto-post 4 orphan file messages into the channel.
      const slackApi = this.overrides.slackApi;
      const filesUploadV2: (args: Record<string, unknown>) => Promise<unknown> = slackApi
        ? (args) => slackApi.filesUploadV2(args)
        : // biome-ignore lint/suspicious/noExplicitAny: Slack SDK `FilesUploadV2Arguments` is a tagged union with `file_uploads` required on the multi-file branch; single-file branch types collide when passed through `Record<string, unknown>`.
          (args) => this.deps.slackApi.getClient().filesUploadV2(args as any);

      const uploadTab = async (tabId: TabId): Promise<[TabId, string]> => {
        let res: unknown;
        try {
          res = await filesUploadV2({
            filename: `usage-card-${tabId}.png`,
            file: pngMap[tabId],
            request_file_info: false,
          });
        } catch (err) {
          throw new SlackUploadError('filesUploadV2 failed', err);
        }
        return [tabId, extractFileId(res)];
      };
      const uploadResults = await Promise.all(tabIds.map((t) => uploadTab(t)));
      const fileIds = Object.fromEntries(uploadResults) as Record<TabId, string>;

      // Post carousel message with cold-cache retry. `postMessage` may reject
      // with `invalid_blocks` if Slack's internal file index hasn't propagated
      // the freshly-uploaded file IDs yet; retry up to 3× with 500ms spacing.
      const blocks = buildCarouselBlocks(fileIds, '30d', user);
      const caption = `${carouselStats.targetUserName || carouselStats.targetUserId} — Usage Card`;
      const postMessage =
        slackApi?.postMessage ??
        (async (args: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }) => {
          return this.deps.slackApi.getClient().chat.postMessage(args as any);
        });

      let postRes: { ts: string } | undefined;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = (await postMessage({
            channel,
            thread_ts: threadTs,
            blocks,
            text: caption,
          })) as { ts: string };
          postRes = res;
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          if (!isInvalidBlocksError(err)) {
            throw new SlackPostError('postMessage failed', err);
          }
          if (attempt < 2) {
            await sleepImpl(500);
          }
        }
      }
      if (!postRes) {
        throw new SlackPostError('postMessage invalid_blocks retry exhausted', lastErr);
      }
      const messageTs = postRes.ts;

      // Populate tabCache — keyed by messageTs, 24h TTL.
      const tabCache = this.overrides.tabCache ?? defaultTabCache;
      tabCache.set(messageTs, {
        fileIds,
        userId: user,
        expiresAt: now.getTime() + 24 * 60 * 60 * 1000,
      });

      const pngBytes = Object.values(pngMap).reduce((s, b) => s + b.byteLength, 0);
      this.logger.info('usage_card_posted', {
        userId: user,
        messageTs,
        pngBytes,
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
        await this.postDmAlert(user, kind);
        return { handled: true };
      }
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
    const periodLabel = period === 'today' ? '최근 24시간' : period === 'week' ? '최근 7일' : '최근 30일';
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

/**
 * Defensive `filesUploadV2` response file-id extractor.
 *
 * Bolt v2 normalizes to a nested `{ files: [{ files: [{id}] }] }` shape, but
 * legacy Slack SDK responses use a flat `{ file: { id } }` or
 * `{ files: [{id}] }`. Probe all three before giving up.
 */
function extractFileId(res: unknown): string {
  const r = res as Record<string, unknown> | null | undefined;
  if (r && Array.isArray(r.files) && r.files.length > 0) {
    const first = r.files[0] as Record<string, unknown>;
    if (first && Array.isArray(first.files) && (first.files as unknown[]).length > 0) {
      const inner = (first.files as unknown[])[0] as Record<string, unknown>;
      if (typeof inner?.id === 'string') return inner.id;
    }
    if (typeof first?.id === 'string') return first.id;
  }
  const f = r?.file as Record<string, unknown> | undefined;
  if (typeof f?.id === 'string') return f.id;
  throw new SlackUploadError('filesUploadV2 response missing file id', res);
}

/**
 * True if `err` is a Slack `invalid_blocks` API rejection. Retryable because
 * it usually indicates the freshly-uploaded file ID hasn't yet propagated
 * through Slack's internal file index.
 *
 * Only the structured `err.data.error` field is trusted — substring-matching
 * `err.message` was rejected because any wrapped error whose stringified
 * message happens to contain the literal (e.g. a log line or a different
 * upstream error) would spuriously trigger retry.
 */
function isInvalidBlocksError(err: unknown): boolean {
  const e = err as { data?: { error?: string } } | null | undefined;
  return e?.data?.error === 'invalid_blocks';
}
