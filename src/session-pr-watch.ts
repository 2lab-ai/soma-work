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
  deliver?: (sessionKey: string, text: string, done?: (outcome: DeliveryOutcome) => void) => Promise<boolean>;
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
  /** `url@sha` whose message waits in the delivery queue. */
  const inflight = new Set<string>();
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
    // Only the one live session that owns the PR is woken: a PR on several cards (a reviewer session, an
    // orchestrator that mentioned it) has no clear owner, and two sessions pushing fixes to one branch is worse
    // than none (#929 review). Their cards still follow the PR (the merge/close notice above).
    if (d.cards.length !== 1) return;
    const record = store.get(key);
    if (record?.ciSha === sha) return;
    const ciKey = `${key}@${sha}`;
    // A message for this head already waits for the session to settle.
    if (inflight.has(ciKey)) return;
    const before = checksKnown.get(ciKey);
    const answer = await fetchChecks(d.owner, d.repo, sha, before?.etag);
    const checks = answer === 'not-modified' ? before : answer;
    if (!checks) return;
    if (answer !== 'not-modified') checksKnown.set(ciKey, answer as ChecksAnswer);
    if (checks.conclusion === 'pending') return;
    const conclusion = checks.conclusion;
    const commit = () => {
      checksKnown.delete(ciKey);
      store.set(key, { ...store.get(key), ciSha: sha, ciConclusion: conclusion });
    };
    let text: string | undefined;
    if (conclusion === 'failure') text = ciMessage(number, d.url, sha, checks.failed);
    else if (record?.ciConclusion === 'failure') text = ciMessage(number, d.url, sha, undefined);
    if (!text) {
      commit();
      return;
    }
    // Recorded when the turn is injected (or given up as stale), not before: a restart while the message waits
    // for the session to settle reads the head as untold and queues it again (#929 review).
    inflight.add(ciKey);
    const done = (outcome: DeliveryOutcome) => {
      inflight.delete(ciKey);
      if (outcome !== 'gone') commit();
    };
    const sessionKey = d.cards[0].sessionKey;
    try {
      if (!(await deliver(sessionKey, text, done))) inflight.delete(ciKey);
    } catch (error) {
      inflight.delete(ciKey);
      deps.logger?.debug('PR watch delivery failed', { sessionKey, error: (error as Error)?.message });
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

/** #929 review — whether a host turn can start in a session now. 'gone' = the session cannot take one at all. */
export type DeliveryState = 'ready' | 'busy' | 'gone';
/** How a queued message ended: injected, given up as stale, or its session went away. */
export type DeliveryOutcome = 'injected' | 'expired' | 'gone';

export interface SettledDeliveryDeps {
  /** 'ready' = idle, no request running and no dispatch slot held (a synthetic turn would otherwise be dropped). */
  state: (sessionKey: string) => DeliveryState;
  inject: (sessionKey: string, text: string) => Promise<void>;
  retryMs?: number;
  /** A message still waiting this long is dropped: a CI result hours old would only mislead. */
  maxWaitMs?: number;
  now?: () => number;
  logger?: { debug: (msg: string, meta?: Record<string, unknown>) => void };
}

/**
 * #929 review (trinity) — `SlackHandler.handleMessage` drops a synthetic turn while the session's dispatch slot is
 * held, and the registry's onIdle callbacks fire before a finishing turn releases it. So a host message waits here
 * and is injected only into a session that reads 'ready', checked again every `retryMs` — one message per settle,
 * since an injected turn makes the session busy again. In memory: a restart drops what still waits, and the watch
 * queues it again, because it records a message only when `done` reports it injected (or expired). An injection that
 * fails after that is not retried — at most once.
 */
export function createSettledDelivery(deps: SettledDeliveryDeps): {
  deliver: (sessionKey: string, text: string, done?: (outcome: DeliveryOutcome) => void) => Promise<boolean>;
  stop: () => void;
} {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? 5_000;
  const maxWaitMs = deps.maxWaitMs ?? 6 * 60 * 60 * 1000;
  type Item = { text: string; at: number; done?: (outcome: DeliveryOutcome) => void };
  const pending = new Map<string, Item[]>();
  const settle = (item: Item, outcome: DeliveryOutcome) => {
    try {
      item.done?.(outcome);
    } catch (error) {
      deps.logger?.debug('PR watch delivery callback failed', { error: (error as Error)?.message });
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;

  const flush = (sessionKey: string): void => {
    const queue = pending.get(sessionKey);
    if (!queue?.length) {
      pending.delete(sessionKey);
      return;
    }
    while (queue.length > 0 && now() - queue[0].at > maxWaitMs) {
      settle(queue.shift() as Item, 'expired');
      deps.logger?.debug('PR watch message expired before the session settled', { sessionKey });
    }
    let state: DeliveryState;
    try {
      state = deps.state(sessionKey);
    } catch {
      state = 'busy';
    }
    if (state === 'gone') for (const item of queue.splice(0)) settle(item, 'gone');
    if (state === 'ready' && queue.length > 0) {
      const next = queue.shift() as Item;
      settle(next, 'injected');
      deps.inject(sessionKey, next.text).catch((error) => {
        deps.logger?.debug('PR watch injection failed', { sessionKey, error: (error as Error)?.message });
      });
    }
    if (queue.length === 0) pending.delete(sessionKey);
  };

  const ensureTimer = (): void => {
    if (timer || pending.size === 0) return;
    timer = setInterval(() => {
      for (const key of [...pending.keys()]) flush(key);
      if (pending.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }, retryMs);
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    async deliver(sessionKey, text, done) {
      if (deps.state(sessionKey) === 'gone') return false;
      const queue = pending.get(sessionKey) ?? [];
      queue.push({ text, at: now(), ...(done ? { done } : {}) });
      pending.set(sessionKey, queue);
      flush(sessionKey);
      ensureTimer();
      return true;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
