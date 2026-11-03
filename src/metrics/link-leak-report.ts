/**
 * The daily leak report (#835, epic #831): bot-authored, non-deploy PRs and issues opened in the last 24 hours, against
 * the links on every task card (live sessions and archives). On 3 November 2026 the figure was 9 of 15.
 *
 * Per item: on a card, missed (on none), or on the wrong card (on cards, but not on the card of the session that wrote
 * it). The writer is the first session whose `pr_created` metric carries `proven: true` — emitted only for a write
 * whose result proved the create (#832, #844). An older `pr_created` fired for any PR URL in a tool result, so it names
 * no creator: the item counts under `unknown`. A wrong card is judged for PRs only (an issue's creator is not
 * recorded). The report
 * posts every day; it alerts only after a baseline week, and only above that week's median, so PRs that are meant to
 * have no card (cron, manual runs) do not page anyone. The run of zero-miss days is the epic's done signal.
 */

import { atomicWriteJson } from '@soma/common/atomic-write';
import { escapeSlackMrkdwn } from '@soma/slack/mrkdwn-escape';
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
  /** A PR whose details GitHub would not give: counted (it may be a deploy PR), and named in the post. */
  unverified?: true;
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
  /** PRs counted although GitHub would not give their details. */
  unverified?: number;
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
  const unverified = items.filter((i) => i.unverified).length;
  return { total: items.length, onCard, missed, wrongCard, bySession, ...(unverified ? { unverified } : {}) };
}

const BASELINE_DAYS = 7;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Alert only after a baseline week of days with bot items, and only when today's misses are above that week's median.
 * A day with no bot item says nothing about the leak, so it is not part of the baseline.
 */
export function shouldAlert(history: LeakHistoryEntry[], today: LeakHistoryEntry): boolean {
  const measured = history.filter((h) => h.total > 0);
  if (measured.length < BASELINE_DAYS) return false;
  return today.missed > median(measured.slice(-BASELINE_DAYS).map((h) => h.missed));
}

/**
 * The run of most recent days with bot items and none missed. A measured day with no bot item is no evidence: it
 * neither counts nor breaks the run (so a quiet weekend is not "3 days in a row"). A day with no report at all breaks
 * it: the days must follow one another on the calendar.
 */
export function zeroStreak(history: LeakHistoryEntry[]): number {
  let n = 0;
  let next: number | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const at = Date.parse(`${history[i].date}T00:00:00Z`);
    if (next !== undefined && next - at !== DAY_MS) break;
    next = at;
    if (history[i].total === 0) continue;
    if (history[i].missed !== 0) break;
    n++;
  }
  return n;
}

/** A metrics event, as far as the creator lookup reads it. */
export interface CreatorEvent {
  eventType: string;
  sessionKey?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Canonical PR URL → the session that wrote it: the first proven `pr_created` (`metadata.proven === true`, #844) at or
 * after `sinceMs`, events in time order. An unproven one — a session that only read the PR — names no one.
 */
export function creatorsOf(events: Iterable<CreatorEvent>, sinceMs: number): Map<string, string> {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const creators = new Map<string, string>();
  for (const e of sorted) {
    const url = e.metadata?.prUrl;
    if (e.eventType !== 'pr_created' || e.metadata?.proven !== true) continue;
    if (typeof url !== 'string' || !e.sessionKey || e.timestamp < sinceMs) continue;
    const key = canonicalLinkUrl(url);
    if (!creators.has(key)) creators.set(key, e.sessionKey);
  }
  return creators;
}

/**
 * The metrics days (`YYYY-MM-DD`) to read for a window: one day of margin on each side, so the store's own partition
 * (by REPORT_TIMEZONE, up to a day off UTC) is always covered.
 */
export function creatorDays(sinceMs: number, nowMs: number): [string, string] {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [day(sinceMs - DAY_MS), day(nowMs + DAY_MS)];
}

function ref(item: BotItem): string {
  return `<${item.url}|${item.repo}#${item.number}>`;
}

/** A title from GitHub, as plain text: it cannot mention anyone or add a link. */
function plain(title: string | undefined): string {
  return title ? escapeSlackMrkdwn(title) : '';
}

/** Slack takes 50 blocks a message; the summary keeps one. */
const MAX_LIST_BLOCKS = 49;

/**
 * Every line under a heading, whole lines only, as many mrkdwn texts as it takes (each within Slack's 3,000-character
 * limit), and whether all fit in `maxTexts`. Past it the rest are counted instead of listed.
 */
function listTexts(heading: string, lines: string[], maxTexts: number): { texts: string[]; complete: boolean } {
  const budget = 2800;
  const texts: string[] = [];
  let cur = [`*${heading}*`];
  let used = cur[0].length;
  let shown = 0;
  for (const line of lines) {
    const clipped = line.length > budget - 40 ? `${line.slice(0, budget - 41)}…` : line;
    if (used + clipped.length + 1 > budget) {
      if (texts.length + 1 >= maxTexts) break;
      texts.push(cur.join('\n'));
      cur = [];
      used = 0;
    }
    cur.push(clipped);
    used += clipped.length + 1;
    shown++;
  }
  if (shown < lines.length) cur.push(`… and ${lines.length - shown} more`);
  texts.push(cur.join('\n'));
  return { texts, complete: shown === lines.length };
}

/** The item lists, full lines when they all fit in the message, else compact ones (number only) so every item is named. */
function listSections(report: LeakReport): string[] {
  const missedLines = (full: boolean) =>
    report.missed.map(
      (i) => `• ${ref(i)}${i.unverified ? ' (not read)' : ''}${full && i.title ? ` ${plain(i.title)}` : ''}`,
    );
  const wrongLines = (full: boolean) =>
    report.wrongCard.map(
      (w) => `• ${ref(w.item)} made by \`${w.creator}\`${full ? `, on \`${w.cards.join('`, `')}\`` : ''}`,
    );
  const sessionLines = report.bySession.map((r) => `\`${r.sessionKey}\`: ${r.missed} missed, ${r.wrong} wrong card`);
  const build = (full: boolean) => {
    const out: string[] = [];
    let complete = true;
    for (const [heading, lines] of [
      ['Missed', missedLines(full)],
      ['On the wrong card', wrongLines(full)],
      ['Per session', sessionLines],
    ] as const) {
      if (lines.length === 0) continue;
      const left = MAX_LIST_BLOCKS - out.length;
      if (left <= 0) {
        complete = false;
        break;
      }
      const r = listTexts(heading, [...lines], left);
      out.push(...r.texts);
      complete &&= r.complete;
    }
    return { out, complete };
  };
  const full = build(true);
  return full.complete ? full.out : build(false).out;
}

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

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
  lines.push(`On a card: ${report.onCard}. On the wrong session's card (PRs): ${report.wrongCard.length}.`);
  const unread = report.unverified ?? 0;
  if (unread > 0) {
    lines.push(
      `${unread} PR${unread === 1 ? '' : 's'} could not be read on GitHub and ${unread === 1 ? 'is' : 'are'} counted as found (one of them may be a deploy PR).`,
    );
  }
  lines.push(`Days in a row with nothing missed: ${opts.streak}.`);
  // `baselineDays` counts days with bot items, as the alert does.
  if (opts.baselineDays < BASELINE_DAYS)
    lines.push(`Baseline: day ${opts.baselineDays} of ${BASELINE_DAYS} with bot items, no alerts yet.`);
  const blocks: any[] = [section(lines.join('\n')), ...listSections(report).map(section)];
  return { text, blocks };
}

// ── GitHub source ───────────────────────────────────────────────────────────────────────────────────────────────────

type FetchLike = (
  url: string,
  init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;

/** What GitHub said when it refused, for the log: the status and the start of its message. */
async function refusal(res: { status?: number; json: () => Promise<any> }): Promise<Record<string, unknown>> {
  let message: unknown;
  try {
    message = (await res.json())?.message;
  } catch {
    message = undefined;
  }
  return { status: res.status, ...(typeof message === 'string' ? { message: message.slice(0, 200) } : {}) };
}

/**
 * The PRs and issues the App opened since `sinceIso`, across the repos its installation can see (GitHub search,
 * `author:app/<login>`). Deploy PRs — base or head `deploy/*` — are dropped. Undefined when the search failed (logged
 * with GitHub's status); a PR whose details cannot be read is skipped and logged, not the whole day.
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
    // GitHub documents whole seconds for a `created:` qualifier.
    const since = args.sinceIso.replace(/\.\d+Z$/, 'Z');
    const q = encodeURIComponent(`author:app/${args.botLogin} created:>=${since}`);
    // Every page (search returns at most 1,000 results, 100 a page).
    const found: any[] = [];
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const res = await doFetch(
        `https://api.github.com/search/issues?q=${q}&per_page=100&page=${page}&sort=created&order=asc`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) {
        logger.warn('GitHub search for the bot items was refused', { page, ...(await refusal(res)) });
        return undefined;
      }
      const body = await res.json();
      if (!body || !Array.isArray(body.items) || body.incomplete_results === true) {
        logger.warn('GitHub search for the bot items came back incomplete', {
          page,
          incomplete: body?.incomplete_results === true,
        });
        return undefined;
      }
      found.push(...body.items);
      total = typeof body.total_count === 'number' ? body.total_count : found.length;
      if (body.items.length < 100 || found.length >= total) break;
    }
    // Search returns at most 1,000 results: a day past it cannot be told complete.
    if (found.length < total) {
      logger.warn('GitHub search returned fewer bot items than it counted; the day is not reported', {
        found: found.length,
        total,
      });
      return undefined;
    }
    const out: BotItem[] = [];
    for (const it of found) {
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
        if (!pr.ok) {
          // Counted, flagged and named: leaving it out could turn a leak into a clean day.
          logger.warn('Could not read a bot PR; it is counted and flagged', {
            pr: it.html_url,
            ...(await refusal(pr)),
          });
          out.push({ ...itemOf(it, m, kind), unverified: true });
          continue;
        }
        const detail = await pr.json();
        const refs = [detail?.base?.ref, detail?.head?.ref].filter((r): r is string => typeof r === 'string');
        if (refs.some((r) => r.startsWith('deploy/'))) continue;
      }
      out.push(itemOf(it, m, kind));
    }
    return out;
  } catch (error) {
    logger.warn('Failed to list the bot items on GitHub', { error: (error as Error)?.message });
    return undefined;
  }
}

function itemOf(it: any, m: RegExpMatchArray, kind: 'pr' | 'issue'): BotItem {
  return {
    url: it.html_url,
    kind,
    repo: m[1],
    number: Number(m[3]),
    ...(typeof it.title === 'string' ? { title: it.title.slice(0, 200) } : {}),
    createdAt: String(it.created_at ?? ''),
  };
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
/** After a failed run (GitHub unreadable, the post refused), wait this long before trying again. */
const RETRY_MS = 15 * 60 * 1000;

export class LinkLeakReporter {
  private timer?: NodeJS.Timeout;
  private running = false;
  private retryAt = 0;

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

  /**
   * The newer usable copy of the state: the live file or its `.bak` (written first on success). A live file that is
   * damaged, or older than the `.bak` because its own write failed, does not reset the baseline or re-post the day.
   */
  private readState(): LeakState {
    const read = (file: string): LeakState | undefined => {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LeakState> | null;
        if (!v || typeof v !== 'object' || !Array.isArray(v.history)) throw new Error('not a link leak state');
        return { lastRunDate: typeof v.lastRunDate === 'string' ? v.lastRunDate : undefined, history: v.history };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          logger.warn('Link leak report state copy is unusable', { file, error: (error as Error)?.message });
        }
        return undefined;
      }
    };
    const live = read(this.deps.statePath);
    const bak = read(`${this.deps.statePath}.bak`);
    if (live && bak) return (bak.lastRunDate ?? '') > (live.lastRunDate ?? '') ? bak : live;
    return live ?? bak ?? { history: [] };
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
      baselineDays: state.history.filter((h) => h.total > 0).length,
    });
  }

  /** Once a day at the configured hour: compute, post, and record the day only when the post landed. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { date, hour } = this.clock();
      if (hour !== this.deps.hour || this.now() < this.retryAt) return;
      const state = this.readState();
      if (state.lastRunDate === date) return;
      // A failed attempt waits before the next one, so an outage costs a few queries, not one a minute.
      this.retryAt = this.now() + RETRY_MS;
      const report = await this.compute();
      if (!report) {
        logger.warn('Link leak report: GitHub could not be read; trying again in 15 minutes');
        return;
      }
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
        baselineDays: history.filter((h) => h.total > 0).length,
      });
      if (!(await this.deps.publish(formatted.text, formatted.blocks))) return;
      // The .bak holds the same good state, so a damaged live file never resets the baseline or re-posts the day.
      const next: LeakState = { lastRunDate: date, history };
      atomicWriteJson(`${this.deps.statePath}.bak`, next);
      atomicWriteJson(this.deps.statePath, next);
      this.retryAt = 0;
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
