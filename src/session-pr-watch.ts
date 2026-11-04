/**
 * Session PR watch (#928, epic #935) — after the turn ends, a session's PR keeps its card current.
 *
 * The turn-end reconcile (#833) and the write receipt (#832) record a PR while the session works. A person merging on
 * GitHub after the last turn changed nothing, so the card kept 'open' (#644). dsh-superagent's Ticket subscribes to its
 * pull request and ends with one chat notice when it merges or closes (docs/003-execution.md §Pull requests).
 *
 * Each tick reads the current PR (`links.pr`) of every session that is not terminated, was active within
 * {@link WATCH_HORIZON_MS}, and whose card does not already say merged or closed — one ask per PR, the least recently
 * asked first, at most {@link MAX_PER_TICK}. An ask carries the last ETag (GitHub does not count a 304 against the rate
 * limit). A changed state goes on the card; a merge or a close also posts one notice in the session's thread. The state
 * is stored before the notice is posted, so a restart never repeats one (at most once). Never throws.
 */
import { tr } from '@soma/common/i18n';
import { canonicalLinkUrl } from '@soma/slack/session-link-capture';

export type PullStatus = 'open' | 'draft' | 'merged' | 'closed';

/** One session as the watch reads it. */
export interface WatchCandidate {
  sessionKey: string;
  terminated?: boolean;
  /** When the session last did something (ms) — a session idle past the horizon is not watched. */
  lastActivityMs?: number;
  /** The card's current PR link. */
  pr?: { url?: string; status?: string } | null;
}

/** What GitHub said about one PR. */
export interface PullAnswer {
  number: number;
  status: PullStatus;
  etag?: string;
}

export interface PrWatchDeps {
  sessions: () => Iterable<WatchCandidate>;
  /** GET the PR, `etag` as If-None-Match: 'not-modified' on a 304, undefined on any failure. */
  fetchPull: (
    owner: string,
    repo: string,
    number: number,
    etag?: string,
  ) => Promise<PullAnswer | 'not-modified' | undefined>;
  /** Put the state on the card's link (the registry's 'update'); whether it changed (then it is saved). */
  updateStatus: (sessionKey: string, url: string, status: PullStatus) => boolean;
  pushCard: (sessionKey: string) => void;
  /** Post one line in the session's thread (a session with no Slack thread posts nothing). */
  notify: (sessionKey: string, text: string) => Promise<void>;
  now?: () => number;
  maxPerTick?: number;
  horizonMs?: number;
  logger?: { debug: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface SessionPrWatch {
  tick: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

/** A session quiet for longer than this is not watched (dsh polls a Thread for two weeks after its last Trigger). */
export const WATCH_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
/** At most this many PRs are asked about per tick. */
export const MAX_PER_TICK = 20;
export const WATCH_INTERVAL_MS = 60_000;

const PULL_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/i;
const FINAL = new Set(['merged', 'closed']);

/** The card state of a PR as GitHub reports it. */
export function pullStatusOf(p: { state?: string; draft?: boolean; merged?: boolean }): PullStatus {
  if (p.merged) return 'merged';
  if (p.state === 'closed') return 'closed';
  return p.draft ? 'draft' : 'open';
}

function noticeText(number: number, url: string, status: PullStatus): string | undefined {
  if (status === 'merged') return tr`🟣 PR #${number} 머지됨 — ${url}`;
  if (status === 'closed') return tr`🔴 PR #${number} 머지 없이 닫힘 — ${url}`;
  return undefined;
}

interface Due {
  url: string;
  owner: string;
  repo: string;
  number: number;
  /** The sessions whose card shows this PR, with the state each card shows. */
  cards: Array<{ sessionKey: string; status?: string }>;
}

export function createSessionPrWatch(deps: PrWatchDeps): SessionPrWatch {
  const now = deps.now ?? Date.now;
  const maxPerTick = deps.maxPerTick ?? MAX_PER_TICK;
  const horizon = deps.horizonMs ?? WATCH_HORIZON_MS;
  /** url → the last answer (its ETag and state), so a 304 can still apply a state a card missed. */
  const known = new Map<string, { etag?: string; status: PullStatus; number: number }>();
  const askedAt = new Map<string, number>();
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function due(): Due[] {
    const byUrl = new Map<string, Due>();
    for (const s of deps.sessions()) {
      if (!s?.sessionKey || s.terminated) continue;
      if (typeof s.lastActivityMs === 'number' && now() - s.lastActivityMs > horizon) continue;
      const raw = s.pr?.url;
      if (typeof raw !== 'string' || FINAL.has(String(s.pr?.status))) continue;
      const url = canonicalLinkUrl(raw);
      const m = url.match(PULL_URL);
      if (!m) continue;
      const key = url.toLowerCase();
      const entry = byUrl.get(key) ?? { url, owner: m[1], repo: m[2], number: Number(m[3]), cards: [] };
      entry.cards.push({ sessionKey: s.sessionKey, status: s.pr?.status });
      byUrl.set(key, entry);
    }
    return [...byUrl.values()]
      .sort((a, b) => (askedAt.get(a.url.toLowerCase()) ?? 0) - (askedAt.get(b.url.toLowerCase()) ?? 0))
      .slice(0, maxPerTick);
  }

  async function check(d: Due): Promise<void> {
    const key = d.url.toLowerCase();
    askedAt.set(key, now());
    const before = known.get(key);
    const answer = await deps.fetchPull(d.owner, d.repo, d.number, before?.etag);
    if (!answer) return;
    const state = answer === 'not-modified' ? before : answer;
    if (!state) return;
    if (answer !== 'not-modified') known.set(key, { etag: answer.etag, status: answer.status, number: answer.number });
    // A card that did not take the state (its link was being rewritten) is tried again: the answer stays known.
    let missed = false;
    for (const card of d.cards) {
      if (card.status === state.status) continue;
      // Stored first: a restart reads 'merged' / 'closed' and never posts the notice again.
      if (!deps.updateStatus(card.sessionKey, d.url, state.status)) {
        missed = true;
        continue;
      }
      deps.pushCard(card.sessionKey);
      const text = noticeText(state.number, d.url, state.status);
      if (text) {
        await deps.notify(card.sessionKey, text).catch((error) => {
          deps.logger?.debug('PR watch notice failed', {
            sessionKey: card.sessionKey,
            error: (error as Error)?.message,
          });
        });
      }
    }
    if (FINAL.has(state.status) && !missed) {
      known.delete(key);
      askedAt.delete(key);
    }
  }

  async function run(): Promise<void> {
    let list: Due[] = [];
    try {
      list = due();
    } catch (error) {
      deps.logger?.debug('PR watch could not list sessions', { error: (error as Error)?.message });
      return;
    }
    for (const d of list) {
      try {
        await check(d);
      } catch (error) {
        deps.logger?.debug('PR watch check failed', { url: d.url, error: (error as Error)?.message });
      }
    }
  }

  const tick = (): Promise<void> => {
    if (running) return running;
    running = run().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    tick,
    start(intervalMs = WATCH_INTERVAL_MS) {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
