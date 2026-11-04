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
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
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
  /** The PR's head commit — the one whose CI is read (#929). */
  headSha?: string;
  etag?: string;
}

/** The check runs of one commit, folded: pending until every run completed. */
export interface ChecksAnswer {
  conclusion: 'pending' | 'success' | 'failure';
  failed: string[];
  etag?: string;
}

/** What the watch keeps across restarts for one PR (#929): the last head whose CI finished, and how. */
export interface PrWatchRecord {
  ciSha?: string;
  ciConclusion?: 'success' | 'failure';
}

export interface PrWatchStore {
  get: (key: string) => PrWatchRecord | undefined;
  set: (key: string, record: PrWatchRecord) => void;
  delete: (key: string) => void;
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
  /** #929 — the check runs of a commit, `etag` as If-None-Match. Without it (or `deliver`, or `store`) CI is not read. */
  fetchChecks?: (
    owner: string,
    repo: string,
    sha: string,
    etag?: string,
  ) => Promise<ChecksAnswer | 'not-modified' | undefined>;
  /** #929 — hand the session a host message: wake it when idle, else when it settles. */
  deliver?: (sessionKey: string, text: string) => Promise<boolean>;
  /** #929 — what was already delivered, kept across restarts. Undefined (unreadable) = deliver nothing. */
  store?: PrWatchStore;
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

const FAILED_RUN = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
/** A host message to the model stays short: the links say the rest. */
const MAX_MESSAGE = 600;

/** Fold a commit's check runs (`filter=latest`): pending while any runs; failure names the failed ones. */
export function checksConclusionOf(
  runs: ReadonlyArray<{ name?: string; status?: string | null; conclusion?: string | null }>,
): { conclusion: ChecksAnswer['conclusion']; failed: string[] } {
  if (runs.length === 0 || runs.some((r) => r.status !== 'completed')) return { conclusion: 'pending', failed: [] };
  const failed = runs.filter((r) => FAILED_RUN.has(String(r.conclusion))).map((r) => String(r.name ?? 'check'));
  return failed.length > 0 ? { conclusion: 'failure', failed } : { conclusion: 'success', failed: [] };
}

function ciMessage(number: number, url: string, sha: string, failed: string[] | undefined): string {
  const head = sha.slice(0, 7);
  if (!failed) {
    return (
      `[pr-watch] CI passed on PR #${number} (head ${head}) after an earlier failure.\n${url}\n` +
      'This comes from the host, not the user. Continue if the task was waiting on CI; otherwise end the turn in one line.'
    );
  }
  const tail =
    `\n${url}/checks\nThis comes from the host, not the user. Read the failing logs and fix it if the fix is within ` +
    "this session's task; otherwise say in one line why not.";
  let jobs = failed.join(', ');
  const lead = `[pr-watch] CI failed on PR #${number} (head ${head}): `;
  const room = MAX_MESSAGE - lead.length - tail.length;
  if (jobs.length > room) jobs = `${jobs.slice(0, Math.max(0, room - 2))}…`;
  return `${lead}${jobs}.${tail}`.slice(0, MAX_MESSAGE);
}

/**
 * #929 — the watch's record file (`$DATA_DIR/pr-watch.json`), written atomically. Undefined when the file exists but
 * cannot be read: the caller then delivers nothing rather than delivering again (`rules/config.md` rule 4).
 */
export function createFilePrWatchStore(
  file: string,
  warn?: (message: string, detail?: unknown) => void,
): PrWatchStore | undefined {
  let data: Record<string, PrWatchRecord>;
  try {
    data =
      readJsonWithBackup(
        file,
        (raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
          return raw as Record<string, PrWatchRecord>;
        },
        warn ? { warn } : {},
      ) ?? {};
  } catch (error) {
    warn?.('PR watch store is unreadable — CI delivery is off', { file, error: (error as Error)?.message });
    return undefined;
  }
  const save = () => atomicWriteJson(file, data, warn ? { warn } : {});
  return {
    get: (key) => data[key],
    set: (key, record) => {
      data[key] = record;
      save();
    },
    delete: (key) => {
      if (!(key in data)) return;
      delete data[key];
      save();
    },
  };
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
  const known = new Map<string, { etag?: string; status: PullStatus; number: number; headSha?: string }>();
  /** `url@sha` → the checks' last ETag and answer, so a 304 repeats it. */
  const checksKnown = new Map<string, ChecksAnswer>();
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
    if (answer !== 'not-modified') {
      known.set(key, { etag: answer.etag, status: answer.status, number: answer.number, headSha: answer.headSha });
    }
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
    if (FINAL.has(state.status)) {
      // A finished PR has no more CI to tell about.
      deps.store?.delete(key);
      if (!missed) {
        known.delete(key);
        askedAt.delete(key);
      }
      return;
    }
    await checkCi(d, key, state.number, state.headSha);
  }

  /** #929 — one finished CI per head: a failure, or a pass after a failure, reaches the session once. */
  async function checkCi(d: Due, key: string, number: number, sha: string | undefined): Promise<void> {
    const { fetchChecks, deliver, store } = deps;
    if (!fetchChecks || !deliver || !store || !sha) return;
    const record = store.get(key);
    if (record?.ciSha === sha) return;
    const ciKey = `${key}@${sha}`;
    const before = checksKnown.get(ciKey);
    const answer = await fetchChecks(d.owner, d.repo, sha, before?.etag);
    const checks = answer === 'not-modified' ? before : answer;
    if (!checks) return;
    if (answer !== 'not-modified') checksKnown.set(ciKey, answer as ChecksAnswer);
    if (checks.conclusion === 'pending') return;
    checksKnown.delete(ciKey);
    // Stored first: a restart reads this head as told and never delivers it again.
    store.set(key, { ciSha: sha, ciConclusion: checks.conclusion });
    let text: string | undefined;
    if (checks.conclusion === 'failure') text = ciMessage(number, d.url, sha, checks.failed);
    else if (record?.ciConclusion === 'failure') text = ciMessage(number, d.url, sha, undefined);
    if (!text) return;
    for (const card of d.cards) {
      await Promise.resolve()
        .then(() => deliver(card.sessionKey, text))
        .catch((error) => {
          deps.logger?.debug('PR watch delivery failed', {
            sessionKey: card.sessionKey,
            error: (error as Error)?.message,
          });
        });
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
