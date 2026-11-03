/**
 * The daily leak report (#835, epic #831): bot-authored, non-deploy PRs and issues opened in the last 24 hours, against
 * the links on every task card (live sessions and archives). On 3 November 2026 the figure was 9 of 15.
 *
 * Per item: on a card, missed (on none), or on the wrong card (on cards, but not on the card of the session that wrote
 * it — known from the `pr_created` metric, which comes from the same write effects as the card since #832). The report
 * posts every day; it alerts only after a baseline week, and only above that week's median, so PRs that are meant to
 * have no card (cron, manual runs) do not page anyone. The run of zero-miss days is the epic's done signal.
 */
import { atomicWriteJson } from '@soma/common/atomic-write';
import { canonicalLinkUrl } from '@soma/slack/session-link-capture';
import fs from 'fs';
import { Logger } from '../logger';

const logger = new Logger('LinkLeakReport');

export interface BotItem {
  url: string;
  kind: 'pr' | 'issue';
  /** `owner/repo` */
  repo: string;
  number: number;
  title?: string;
  createdAt: string;
}

interface LinkLike {
  url?: unknown;
}
export interface CardSource {
  sessionKey?: string;
  title?: string;
  links?: { issue?: LinkLike; pr?: LinkLike; doc?: LinkLike } | null;
  linkHistory?: { issues?: Array<LinkLike | null>; prs?: Array<LinkLike | null>; docs?: Array<LinkLike | null> } | null;
}

export interface LeakReport {
  total: number;
  onCard: number;
  missed: BotItem[];
  wrongCard: Array<{ item: BotItem; creator: string; cards: string[] }>;
  bySession: Array<{ sessionKey: string; missed: number; wrong: number }>;
}

export interface LeakHistoryEntry {
  date: string;
  total: number;
  missed: number;
  wrong: number;
}

/** A card's link URLs — its current links and its history — canonical, each once. */
export function cardUrlsOf(src: CardSource | null | undefined): string[] {
  if (!src) return [];
  const out = new Set<string>();
  const add = (l: LinkLike | null | undefined) => {
    if (l && typeof l.url === 'string' && l.url) out.add(canonicalLinkUrl(l.url));
  };
  for (const l of Object.values(src.links ?? {})) add(l);
  for (const list of Object.values(src.linkHistory ?? {})) for (const l of Array.isArray(list) ? list : []) add(l);
  return [...out];
}

/**
 * Which items are on a card, missed, or on the wrong card. `creators` maps a canonical URL to the session that wrote
 * it; an item without one is counted under `unknown` (and cannot be on a wrong card).
 */
export function computeLinkLeakReport(
  items: BotItem[],
  cards: CardSource[],
  creators: ReadonlyMap<string, string>,
): LeakReport {
  const cardsByUrl = new Map<string, string[]>();
  for (const c of cards) {
    const key = c.sessionKey ?? 'unknown';
    for (const url of cardUrlsOf(c)) cardsByUrl.set(url, [...(cardsByUrl.get(url) ?? []), key]);
  }
  const missed: BotItem[] = [];
  const wrongCard: LeakReport['wrongCard'] = [];
  const per = new Map<string, { missed: number; wrong: number }>();
  const bump = (key: string, field: 'missed' | 'wrong') => {
    const row = per.get(key) ?? { missed: 0, wrong: 0 };
    row[field]++;
    per.set(key, row);
  };
  let onCard = 0;
  for (const item of items) {
    const canon = canonicalLinkUrl(item.url);
    const on = cardsByUrl.get(canon) ?? [];
    const creator = creators.get(canon);
    if (on.length === 0) {
      missed.push(item);
      bump(creator ?? 'unknown', 'missed');
      continue;
    }
    onCard++;
    if (creator && !on.includes(creator)) {
      wrongCard.push({ item, creator, cards: [...new Set(on)] });
      bump(creator, 'wrong');
    }
  }
  const bySession = [...per]
    .map(([sessionKey, row]) => ({ sessionKey, ...row }))
    .sort((a, b) =>
      a.sessionKey === 'unknown' ? 1 : b.sessionKey === 'unknown' ? -1 : a.sessionKey.localeCompare(b.sessionKey),
    );
  return { total: items.length, onCard, missed, wrongCard, bySession };
}

const BASELINE_DAYS = 7;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Alert only after a baseline week of reports, and only when today's misses are above that week's median. */
export function shouldAlert(history: LeakHistoryEntry[], today: LeakHistoryEntry): boolean {
  if (history.length < BASELINE_DAYS) return false;
  return today.missed > median(history.slice(-BASELINE_DAYS).map((h) => h.missed));
}

/** The run of most recent days with no missed item. */
export function zeroStreak(history: LeakHistoryEntry[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i].missed === 0; i--) n++;
  return n;
}

function ref(item: BotItem): string {
  return `<${item.url}|${item.repo}#${item.number}>`;
}

export function formatLinkLeakReport(
  report: LeakReport,
  opts: { date: string; alert: boolean; streak: number; baselineDays: number },
): { text: string; blocks: any[] } {
  const missedCount = report.missed.length;
  const text = `Task card link leak, ${opts.date}: ${missedCount} of ${report.total} bot PRs and issues never reached a card`;
  const lines: string[] = [];
  if (opts.alert) lines.push(':rotating_light: Above the baseline week — look at the sessions below.');
  lines.push(
    `*${missedCount} of ${report.total}* bot-authored, non-deploy PRs and issues opened in the last 24 hours are on no task card.`,
  );
  lines.push(`On a card: ${report.onCard}. On the wrong session's card: ${report.wrongCard.length}.`);
  lines.push(`Days in a row with nothing missed: ${opts.streak}.`);
  if (opts.baselineDays < BASELINE_DAYS)
    lines.push(`Baseline: day ${opts.baselineDays} of ${BASELINE_DAYS}, no alerts yet.`);
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
  if (missedCount > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Missed*\n${report.missed.map((i) => `• ${ref(i)} ${i.title ?? ''}`.trim()).join('\n')}`.slice(0, 2900),
      },
    });
  }
  if (report.wrongCard.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*On the wrong card*\n${report.wrongCard.map((w) => `• ${ref(w.item)} made by \`${w.creator}\`, on \`${w.cards.join('`, `')}\``).join('\n')}`.slice(
          0,
          2900,
        ),
      },
    });
  }
  if (report.bySession.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: report.bySession
            .map((r) => `\`${r.sessionKey}\`: ${r.missed} missed, ${r.wrong} wrong card`)
            .join(' · ')
            .slice(0, 2900),
        },
      ],
    });
  }
  return { text, blocks };
}

// ── GitHub source ───────────────────────────────────────────────────────────────────────────────────────────────────

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; json: () => Promise<any> }>;

/**
 * The PRs and issues the App opened since `sinceIso`, across the repos its installation can see (GitHub search,
 * `author:app/<login>`). Deploy PRs — base or head `deploy/*` — are dropped. Undefined when a query failed.
 */
export async function fetchBotItems(args: {
  token: string;
  botLogin: string;
  sinceIso: string;
  fetchImpl?: FetchLike;
}): Promise<BotItem[] | undefined> {
  const doFetch: FetchLike = args.fetchImpl ?? (fetch as unknown as FetchLike);
  const headers = {
    Authorization: `token ${args.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
  };
  try {
    const q = encodeURIComponent(`author:app/${args.botLogin} created:>=${args.sinceIso}`);
    const res = await doFetch(`https://api.github.com/search/issues?q=${q}&per_page=100&sort=created&order=asc`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const body = await res.json();
    if (!body || !Array.isArray(body.items)) return undefined;
    const out: BotItem[] = [];
    for (const it of body.items) {
      const m =
        typeof it?.html_url === 'string'
          ? it.html_url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)$/)
          : null;
      if (!m) continue;
      const kind = it.pull_request ? 'pr' : 'issue';
      if (kind === 'pr') {
        const pr = await doFetch(`https://api.github.com/repos/${m[1]}/pulls/${m[3]}`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!pr.ok) return undefined;
        const detail = await pr.json();
        const refs = [detail?.base?.ref, detail?.head?.ref].filter((r): r is string => typeof r === 'string');
        if (refs.some((r) => r.startsWith('deploy/'))) continue;
      }
      out.push({
        url: it.html_url,
        kind,
        repo: m[1],
        number: Number(m[3]),
        ...(typeof it.title === 'string' ? { title: it.title.slice(0, 200) } : {}),
        createdAt: String(it.created_at ?? ''),
      });
    }
    return out;
  } catch (error) {
    logger.warn('Failed to list the bot items on GitHub', { error: (error as Error)?.message });
    return undefined;
  }
}

// ── The daily run ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface LinkLeakReporterDeps {
  /** Bot items opened since the time (ms); undefined when GitHub could not be read. */
  collectItems: (sinceMs: number) => Promise<BotItem[] | undefined>;
  collectCards: () => CardSource[];
  /** Canonical URL → the session whose write created it, since the time (ms). */
  collectCreators: (sinceMs: number) => Promise<Map<string, string>>;
  publish: (text: string, blocks: any[]) => Promise<boolean>;
  statePath: string;
  timezone: string;
  hour: number;
  now?: () => number;
}

interface LeakState {
  lastRunDate?: string;
  history: LeakHistoryEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 60;

export class LinkLeakReporter {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly deps: LinkLeakReporterDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private clock(): { date: string; hour: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.deps.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(this.now()));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
  }

  private readState(): LeakState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf8'));
      return { lastRunDate: raw?.lastRunDate, history: Array.isArray(raw?.history) ? raw.history : [] };
    } catch {
      return { history: [] };
    }
  }

  private async compute(): Promise<LeakReport | undefined> {
    const since = this.now() - DAY_MS;
    const items = await this.deps.collectItems(since);
    if (!items) return undefined;
    return computeLinkLeakReport(items, this.deps.collectCards(), await this.deps.collectCreators(since));
  }

  /** The report for the last 24 hours, now — nothing is recorded or posted (the `report leaks` command). */
  async runNow(): Promise<{ text: string; blocks: any[] } | undefined> {
    const report = await this.compute();
    if (!report) return undefined;
    const state = this.readState();
    return formatLinkLeakReport(report, {
      date: this.clock().date,
      alert: false,
      streak: zeroStreak(state.history),
      baselineDays: state.history.length,
    });
  }

  /** Once a day at the configured hour: compute, post, and record the day only when the post landed. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { date, hour } = this.clock();
      if (hour !== this.deps.hour) return;
      const state = this.readState();
      if (state.lastRunDate === date) return;
      const report = await this.compute();
      if (!report) return;
      const today: LeakHistoryEntry = {
        date,
        total: report.total,
        missed: report.missed.length,
        wrong: report.wrongCard.length,
      };
      const history = [...state.history.filter((h) => h.date !== date), today].slice(-MAX_HISTORY);
      const formatted = formatLinkLeakReport(report, {
        date,
        alert: shouldAlert(state.history, today),
        streak: zeroStreak(history),
        baselineDays: history.length,
      });
      if (!(await this.deps.publish(formatted.text, formatted.blocks))) return;
      atomicWriteJson(this.deps.statePath, { lastRunDate: date, history });
    } catch (error) {
      logger.warn('Link leak report failed', { error: (error as Error)?.message });
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
