/**
 * LinkMetadataFetcher - Fetches titles and statuses for session links (GitHub PRs, Jira issues)
 * Uses in-memory cache with TTL to minimize API calls.
 */

import { config } from './config';
import { getGitHubAppAuth } from './github-auth';
import type { GitHubReceiptObject } from './github-receipt';
import { Logger } from './logger';
import { type ActivityAnswer, type ActivityItem, type ChecksAnswer, checksConclusionOf } from './session-pr-watch';
import type { SessionLink } from './types';

const logger = new Logger('LinkMetadataFetcher');

interface LinkMetadata {
  title?: string;
  status?: string;
  fetchedAt: number;
}

// Cache: url -> metadata
const metadataCache = new Map<string, LinkMetadata>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
// GitHub PR/issue title max ≈ 256, Jira summary max = 255. 500 is a defensive
// upper bound that never clips real titles but stops a malicious or pathological
// upstream from pinning multi-MB strings in cache.
const MAX_CACHED_TITLE_LENGTH = 500;

// Status emoji mapping
const STATUS_EMOJI: Record<string, string> = {
  // Jira statuses
  'to do': '⬜',
  open: '⬜',
  backlog: '⬜',
  'in progress': '🔵',
  'in development': '🔵',
  'in review': '🟡',
  review: '🟡',
  done: '✅',
  closed: '✅',
  resolved: '✅',
  // GitHub PR statuses
  'pr:open': '🟢',
  'pr:draft': '⚪',
  'pr:merged': '🟣',
  'pr:closed': '🔴',
  // GitHub issue statuses
  'issue:open': '🟢',
  'issue:closed': '✅',
};

/**
 * Resolve a GitHub token: PAT from env, then GitHub App installation token as fallback.
 */
async function getGitHubToken(): Promise<string | null> {
  if (config.github.token) return config.github.token;

  const appAuth = getGitHubAppAuth();
  if (appAuth) {
    try {
      return await appAuth.getInstallationToken();
    } catch (error) {
      logger.warn('Failed to get GitHub App installation token', { error: (error as Error).message });
      return null;
    }
  }

  return null;
}

/**
 * Get status emoji for a normalized status string
 * @public — consumed dynamically via `import * as linkMetadataFetcher` in src/slack/session-manager.ts.
 */
export function getStatusEmoji(status: string | undefined, linkType?: string): string {
  if (!status) return '';
  const key = linkType ? `${linkType}:${status.toLowerCase()}` : status.toLowerCase();
  return STATUS_EMOJI[key] || STATUS_EMOJI[status.toLowerCase()] || '';
}

/**
 * Fetch metadata (title + status) for a link.
 * Returns cached data if fresh, otherwise fetches from API.
 */
export async function fetchLinkMetadata(link: SessionLink): Promise<{ title?: string; status?: string }> {
  const cached = metadataCache.get(link.url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return { title: cached.title || link.title, status: cached.status || link.status };
  }

  try {
    let metadata: { title?: string; status?: string } = {};

    if (link.provider === 'github') {
      metadata = await fetchGitHubMetadata(link);
    } else if (link.provider === 'jira') {
      metadata = await fetchJiraMetadata(link);
    }

    // Cache the title without the legacy 40-char cap so ref-pill hovers and
    // the LLM session-title summarizer see real input — but bound at
    // MAX_CACHED_TITLE_LENGTH to keep memory predictable. Display-time
    // truncation (e.g. dashboard sub-row 60-char clip) remains the consumer's
    // responsibility.
    const cachedTitle =
      metadata.title && metadata.title.length > MAX_CACHED_TITLE_LENGTH
        ? metadata.title.slice(0, MAX_CACHED_TITLE_LENGTH)
        : metadata.title;
    // An empty answer (a refused or rate-limited request, no credentials) does not erase a good one: the last
    // known title and state stay, marked as checked now so the next reader does not ask again at once.
    if (!cachedTitle && !metadata.status && cached && (cached.title || cached.status)) {
      metadataCache.set(link.url, { ...cached, fetchedAt: Date.now() });
      return { title: cached.title || link.title, status: cached.status || link.status };
    }
    metadataCache.set(link.url, {
      title: cachedTitle,
      status: metadata.status,
      fetchedAt: Date.now(),
    });

    return { title: cachedTitle || link.title, status: metadata.status || link.status };
  } catch (error) {
    logger.warn('Failed to fetch link metadata', { url: link.url, error: (error as Error).message });
    // Return existing data on failure (graceful degradation)
    return { title: link.title, status: link.status };
  }
}

/**
 * Batch fetch metadata for multiple links in parallel.
 * Returns enriched copies of the links with title/status filled in.
 * Graceful: individual failures don't block others.
 */
export async function fetchBatchLinkMetadata(links: SessionLink[]): Promise<SessionLink[]> {
  if (links.length === 0) return [];
  const results = await Promise.allSettled(
    links.map(async (link) => {
      const meta = await fetchLinkMetadata(link);
      return { ...link, title: meta.title ?? link.title, status: meta.status ?? link.status };
    }),
  );
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : { ...links[i] }));
}

/**
 * The cache's last answer for a URL (title and state), whatever its age — undefined when it was never fetched.
 * For readers that must not wait (the dashboard board); {@link warmLinkMetadata} keeps it fresh.
 */
export function peekLinkMetadata(url: string): { title?: string; status?: string } | undefined {
  const cached = metadataCache.get(url);
  if (!cached || (!cached.title && !cached.status)) return undefined;
  return { ...(cached.title ? { title: cached.title } : {}), ...(cached.status ? { status: cached.status } : {}) };
}

const WARM_PER_CALL = 8;
/** Background fetches running at once, across every board. */
const WARM_MAX_IN_FLIGHT = 8;
/** Background fetches started per minute, across every board. */
const WARM_PER_MINUTE = 40;
/** A slot is given back after this long even when its request has not answered. */
const WARM_SLOT_TIMEOUT = 15_000;
/** A state that rarely changes again (a closed or done issue, a closed PR) is checked at most this often. */
const FINAL_TTL = 60 * 60 * 1000;
const FINAL_STATE = /^(closed|done|resolved|complete(d)?|fixed|released|완료|종료|해결(됨)?|닫힘)$/i;
const lastWarmAt = new Map<string, number>();
let warmInFlight = 0;
let warmWindow = { start: 0, count: 0 };

/** How long a cached answer is good for: a merged PR never changes; other final states are checked hourly. */
function warmTtl(link: Pick<SessionLink, 'type'>, cached: LinkMetadata | undefined): number {
  const status = cached?.status?.trim() ?? '';
  if (link.type === 'pr' && status.toLowerCase() === 'merged') return Number.POSITIVE_INFINITY;
  return FINAL_STATE.test(status) ? FINAL_TTL : CACHE_TTL;
}

/**
 * Fetch, in the background, the GitHub / Jira issues and PRs whose cached answer is missing or stale (작업 카드의
 * 연결, SSOT 2026-11-02): the board shows what the cache has now and the fresh state on its next draw.
 *
 * Bounded across every board: each URL is tried at most once per TTL (a failed fetch is not retried at every
 * board; a merged PR is never fetched again, other final states hourly), at most {@link WARM_PER_CALL} per call,
 * {@link WARM_MAX_IN_FLIGHT} at once and {@link WARM_PER_MINUTE} per minute. The cache is written by
 * fetchLinkMetadata alone (an injected `fetch` — tests, receipts — is written here). Returns how many fetches
 * started. Never throws, never waits.
 */
export function warmLinkMetadata(
  links: ReadonlyArray<Pick<SessionLink, 'url' | 'type' | 'provider'>>,
  opts: { now?: number; fetch?: (link: SessionLink) => Promise<{ title?: string; status?: string }> } = {},
): number {
  const now = opts.now ?? Date.now();
  if (lastWarmAt.size > 2000) {
    for (const [url, at] of lastWarmAt) if (now - at >= FINAL_TTL) lastWarmAt.delete(url);
  }
  if (now - warmWindow.start >= 60_000 || now < warmWindow.start) warmWindow = { start: now, count: 0 };
  let started = 0;
  for (const link of links) {
    if (started >= WARM_PER_CALL || warmInFlight >= WARM_MAX_IN_FLIGHT || warmWindow.count >= WARM_PER_MINUTE) break;
    if (!link?.url || (link.type !== 'issue' && link.type !== 'pr')) continue;
    if (link.provider !== 'github' && link.provider !== 'jira') continue;
    const cached = metadataCache.get(link.url);
    const ttl = warmTtl(link, cached);
    if (cached && now - cached.fetchedAt < ttl) continue;
    const tried = lastWarmAt.get(link.url);
    if (tried !== undefined && now - tried < ttl) continue;
    lastWarmAt.set(link.url, now);
    started++;
    warmWindow.count++;
    warmInFlight++;
    let pending: Promise<{ title?: string; status?: string }>;
    try {
      pending = Promise.resolve(opts.fetch ? opts.fetch(link as SessionLink) : fetchLinkMetadata(link as SessionLink));
    } catch (error) {
      pending = Promise.reject(error);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      warmInFlight--;
    };
    const slot = setTimeout(release, WARM_SLOT_TIMEOUT);
    if (typeof slot === 'object' && slot && 'unref' in slot) slot.unref();
    pending
      .then((meta) => {
        if (!opts.fetch || !meta || (!meta.title && !meta.status)) return;
        const prev = metadataCache.get(link.url);
        if (!prev || prev.fetchedAt <= now) {
          // Dated when the fetch began (the injected clock): a later entry is kept.
          metadataCache.set(link.url, { title: meta.title, status: meta.status, fetchedAt: now });
        }
      })
      .catch((error) => logger.debug('Background link metadata fetch failed', { url: link.url, error: String(error) }))
      .finally(() => {
        clearTimeout(slot);
        release();
      });
  }
  return started;
}

/**
 * Fetch GitHub PR or issue metadata (title + status) from API.
 */
async function fetchGitHubMetadata(link: SessionLink): Promise<{ title?: string; status?: string }> {
  const token = await getGitHubToken();
  if (!token) return {};

  const match = link.url.match(/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
  if (!match) return {};

  const [, owner, repo, type, number] = match;
  const apiPath = type === 'pull' ? 'pulls' : 'issues';

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/${apiPath}/${number}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
    },
  });

  if (!response.ok) return {};

  const data = (await response.json()) as {
    title?: string;
    state?: string;
    merged?: boolean;
    draft?: boolean;
  };

  let status: string;
  if (type === 'pull') {
    if (data.merged) status = 'merged';
    else if (data.draft) status = 'draft';
    else status = data.state || 'open'; // open or closed
  } else {
    status = data.state || 'open'; // open or closed
  }

  return { title: data.title, status };
}

/** A PR as `GET /repos/{o}/{r}/pulls` lists it — the fields the turn-end reconcile reads (#833). */
export interface GitHubPullSummary {
  html_url: string;
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  created_at?: string;
  body?: string | null;
  /** The PR's head commit. */
  head_sha?: string;
}

/**
 * The PRs whose head is `owner:branch` (any state, newest first, at most 30) — undefined when the query failed. Each
 * answer also fills the metadata cache, so the card's chip shows the PR's state at once (#833).
 */
export async function fetchGitHubPullsForHead(
  owner: string,
  repo: string,
  branch: string,
): Promise<GitHubPullSummary[] | undefined> {
  const token = await getGitHubToken();
  if (!token) return undefined;
  try {
    const head = encodeURIComponent(`${owner}:${branch}`);
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${head}&state=all&sort=created&direction=desc&per_page=30`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return undefined;
    const pulls: GitHubPullSummary[] = [];
    for (const p of data) {
      if (!p || typeof p.html_url !== 'string' || typeof p.number !== 'number') continue;
      const title = typeof p.title === 'string' ? p.title.slice(0, MAX_CACHED_TITLE_LENGTH) : undefined;
      pulls.push({
        html_url: p.html_url,
        number: p.number,
        title,
        state: typeof p.state === 'string' ? p.state : undefined,
        draft: p.draft === true,
        merged_at: typeof p.merged_at === 'string' ? p.merged_at : null,
        created_at: typeof p.created_at === 'string' ? p.created_at : undefined,
        body: typeof p.body === 'string' ? p.body.slice(0, 4000) : null,
        ...(typeof p.head?.sha === 'string' ? { head_sha: p.head.sha } : {}),
      });
      const status = p.merged_at ? 'merged' : p.draft && p.state !== 'closed' ? 'draft' : p.state;
      metadataCache.set(p.html_url, { title, status, fetchedAt: Date.now() });
    }
    return pulls;
  } catch (error) {
    logger.debug('Failed to list PRs for a branch', { owner, repo, error: (error as Error).message });
    return undefined;
  }
}

/**
 * Fetch Jira issue metadata (title + status) from REST API.
 */
async function fetchJiraMetadata(link: SessionLink): Promise<{ title?: string; status?: string }> {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) return {};

  const issueKey = link.label || extractJiraKey(link.url);
  if (!issueKey) return {};

  const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}?fields=summary,status`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) return {};

  const data = (await response.json()) as {
    fields?: {
      summary?: string;
      status?: { name?: string };
    };
  };

  return {
    title: data.fields?.summary,
    status: data.fields?.status?.name,
  };
}

/**
 * Extract a Jira issue key from a browse URL.
 * @public — consumed dynamically via `import * as linkMetadataFetcher` in src/slack/session-manager.ts.
 */
export function extractJiraKey(url: string): string | undefined {
  const match = url.match(/\/browse\/([A-Z]+-\d+)/);
  return match?.[1];
}

function extractGitHubPRInfo(url: string): { owner: string; repo: string; number: number } | undefined {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return undefined;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Jira transition target info
 */
export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string; statusCategory: string };
}

/**
 * Fetch available Jira transitions for an issue.
 * Returns empty array on failure (graceful degradation).
 * @public — consumed dynamically via `import * as linkMetadataFetcher` in src/slack/session-manager.ts.
 */
export async function fetchJiraTransitions(issueKey: string): Promise<JiraTransition[]> {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) return [];

  try {
    const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) return [];

    const data = (await response.json()) as {
      transitions?: Array<{
        id: string;
        name: string;
        to?: { name?: string; statusCategory?: { key?: string } };
      }>;
    };

    return (data.transitions || []).map((t) => ({
      id: t.id,
      name: t.name,
      to: {
        name: t.to?.name || t.name,
        statusCategory: t.to?.statusCategory?.key || 'undefined',
      },
    }));
  } catch (error) {
    logger.warn('Failed to fetch Jira transitions', { issueKey, error: (error as Error).message });
    return [];
  }
}

/**
 * GitHub PR details for merge eligibility check
 */
export interface GitHubPRDetails {
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  draft: boolean;
  head: string; // source branch
  base: string; // target branch
}

/**
 * Fetch GitHub PR details including merge eligibility.
 * Returns undefined on failure.
 */
export async function fetchGitHubPRDetails(link: SessionLink): Promise<GitHubPRDetails | undefined> {
  const token = await getGitHubToken();
  if (!token) return undefined;

  const prInfo = extractGitHubPRInfo(link.url);
  if (!prInfo) return undefined;

  try {
    const response = await fetch(`https://api.github.com/repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.number}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
      },
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      state?: string;
      merged?: boolean;
      mergeable?: boolean | null;
      mergeable_state?: string;
      draft?: boolean;
      head?: { ref?: string };
      base?: { ref?: string };
    };

    return {
      state: data.state || 'open',
      merged: data.merged || false,
      mergeable: data.mergeable ?? null,
      mergeableState: data.mergeable_state || 'unknown',
      draft: data.draft || false,
      head: data.head?.ref || 'unknown',
      base: data.base?.ref || 'unknown',
    };
  } catch (error) {
    logger.warn('Failed to fetch GitHub PR details', { url: link.url, error: (error as Error).message });
    return undefined;
  }
}

/**
 * Check if a PR is eligible for merging
 */
export function isPRMergeable(details: GitHubPRDetails): boolean {
  return (
    details.state === 'open' &&
    !details.draft &&
    !details.merged &&
    details.mergeable === true &&
    details.mergeableState === 'clean'
  );
}

/**
 * Fetch GitHub PR review status (approved / changes_requested / pending).
 * Evaluates the latest review per user to determine the aggregate state.
 */
export async function fetchGitHubPRReviewStatus(
  link: SessionLink,
): Promise<'approved' | 'changes_requested' | 'pending' | undefined> {
  const token = await getGitHubToken();
  if (!token) return undefined;

  const prInfo = extractGitHubPRInfo(link.url);
  if (!prInfo) return undefined;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.number}/reviews`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
        },
      },
    );

    if (!response.ok) return undefined;

    const reviews = (await response.json()) as Array<{
      user?: { login?: string };
      state?: string;
      submitted_at?: string;
    }>;

    if (!reviews || reviews.length === 0) return 'pending';

    // Get the latest review per user
    const latestByUser = new Map<string, string>();
    for (const review of reviews) {
      const login = review.user?.login;
      const state = review.state;
      if (!login || !state) continue;
      // reviews are returned chronologically, so later entries overwrite
      latestByUser.set(login, state);
    }

    const states = [...latestByUser.values()];
    if (states.some((s) => s === 'CHANGES_REQUESTED')) return 'changes_requested';
    if (states.some((s) => s === 'APPROVED')) return 'approved';
    return 'pending';
  } catch (error) {
    logger.warn('Failed to fetch GitHub PR review status', { url: link.url, error: (error as Error).message });
    return undefined;
  }
}

/**
 * #928 — one PR's state for the session PR watch (`session-pr-watch.ts`). `etag` goes out as If-None-Match: a 304
 * (GitHub does not count it against the rate limit) answers 'not-modified'. Undefined on any failure; never throws.
 * An answer also fills the metadata cache, so the thread header and the card read the same state.
 */
export async function fetchGitHubPullState(
  owner: string,
  repo: string,
  number: number,
  etag?: string,
): Promise<
  | { number: number; status: 'open' | 'draft' | 'merged' | 'closed'; headSha?: string; etag?: string }
  | 'not-modified'
  | undefined
> {
  try {
    const token = await getGitHubToken();
    if (!token) return undefined;
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (response.status === 304) return 'not-modified';
    if (!response.ok) return undefined;
    const p = (await response.json()) as {
      html_url?: unknown;
      title?: unknown;
      state?: unknown;
      draft?: unknown;
      merged?: unknown;
      merged_at?: unknown;
      head?: { sha?: unknown };
    };
    const merged = p.merged === true || typeof p.merged_at === 'string';
    const status = merged ? 'merged' : p.state === 'closed' ? 'closed' : p.draft === true ? 'draft' : 'open';
    if (typeof p.html_url === 'string') {
      const title = typeof p.title === 'string' ? p.title.slice(0, MAX_CACHED_TITLE_LENGTH) : undefined;
      metadataCache.set(p.html_url, { title, status, fetchedAt: Date.now() });
    }
    const etagOut = response.headers.get('etag');
    return {
      number,
      status,
      ...(typeof p.head?.sha === 'string' ? { headSha: p.head.sha } : {}),
      ...(etagOut ? { etag: etagOut } : {}),
    };
  } catch (error) {
    logger.debug('Failed to read a PR for the PR watch', { owner, repo, number, error: (error as Error).message });
    return undefined;
  }
}

/**
 * #929 — the latest check runs of one commit, folded by `checksConclusionOf` (pending while any runs). `etag` goes out
 * as If-None-Match; a 304 answers 'not-modified'. Undefined on any failure; never throws.
 */
export async function fetchGitHubCheckRuns(
  owner: string,
  repo: string,
  sha: string,
  etag?: string,
): Promise<ChecksAnswer | 'not-modified' | undefined> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return undefined;
  try {
    const token = await getGitHubToken();
    if (!token) return undefined;
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/check-runs?filter=latest&per_page=100`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (response.status === 304) return 'not-modified';
    if (!response.ok) return undefined;
    const body = (await response.json()) as { check_runs?: unknown; total_count?: unknown };
    if (!Array.isArray(body.check_runs)) return undefined;
    const runs = body.check_runs.filter((r): r is { name?: string; status?: string; conclusion?: string | null } =>
      Boolean(r && typeof r === 'object'),
    );
    const etagOut = response.headers.get('etag');
    // A run past the first page could be failing or still running: never call a partial list a pass.
    const partial = typeof body.total_count === 'number' && body.total_count > body.check_runs.length;
    const folded = partial ? { conclusion: 'pending' as const, failed: [] } : checksConclusionOf(runs);
    return { ...folded, ...(etagOut ? { etag: etagOut } : {}) };
  } catch (error) {
    logger.debug('Failed to read check runs for the PR watch', { owner, repo, sha, error: (error as Error).message });
    return undefined;
  }
}

/**
 * #930 — what was written on a PR after `since`: PR comments and review comments (GitHub's `since`, oldest first,
 * 100 a page) and reviews (no `since` on GitHub: walked back from the last page until a page starts at or before
 * `since`, at most 5 pages). A full comment page sets `until` to its last item — nothing after it is claimed, so the
 * caller reads on from there. All or nothing: one failed read is undefined. Never throws.
 */
export async function fetchGitHubPullActivity(
  owner: string,
  repo: string,
  number: number,
  since: string,
): Promise<ActivityAnswer | undefined> {
  const PER_PAGE = 100;
  const MAX_REVIEW_PAGES = 5;
  try {
    const token = await getGitHubToken();
    if (!token) return undefined;
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const get = async (url: string): Promise<{ items: unknown[]; last?: number } | undefined> => {
      const response = await fetch(url, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) return undefined;
      const last = response.headers.get('link')?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
      return { items: body, ...(last ? { last: Number(last[1]) } : {}) };
    };
    const q = `since=${encodeURIComponent(since)}&per_page=${PER_PAGE}`;
    const reviewsUrl = `${base}/pulls/${number}/reviews?per_page=${PER_PAGE}`;
    const [comments, reviewComments, firstReviews] = await Promise.all([
      get(`${base}/issues/${number}/comments?${q}`),
      get(`${base}/pulls/${number}/comments?${q}`),
      get(reviewsUrl),
    ]);
    if (!comments || !reviewComments || !firstReviews) return undefined;
    type Raw = {
      id?: unknown;
      user?: { login?: unknown; type?: unknown } | null;
      author_association?: unknown;
      html_url?: unknown;
      created_at?: unknown;
      submitted_at?: unknown;
      state?: unknown;
      path?: unknown;
    };
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const sinceMs = Date.parse(since);
    // Reviews are oldest first: the newest are on the last page. Walk back until a page starts before `since`.
    const reviews: unknown[] = [...firstReviews.items];
    if (firstReviews.last && firstReviews.last > 1) {
      const pages: unknown[][] = [];
      for (let n = firstReviews.last; n > 1 && pages.length < MAX_REVIEW_PAGES; n--) {
        const got = await get(`${reviewsUrl}&page=${n}`);
        if (!got) return undefined;
        pages.unshift(got.items);
        // A pending review has no submitted_at: the page starts at its first submitted one.
        const first = got.items
          .map((i) => Date.parse(str((i as Raw | undefined)?.submitted_at) ?? ''))
          .find((at) => Number.isFinite(at));
        // A page of pending reviews only says nothing about time: walk on back.
        if (first !== undefined && first <= sinceMs) break;
      }
      reviews.push(...pages.flat());
    }
    const out: ActivityItem[] = [];
    const add = (raw: unknown, kind: ActivityItem['kind']) => {
      const r = raw as Raw;
      const author = str(r?.user?.login);
      const at = str(kind === 'review' ? r?.submitted_at : r?.created_at);
      const url = str(r?.html_url);
      if (!author || !at || !url || r?.id === undefined) return;
      out.push({
        id: `${kind}:${String(r.id)}`,
        kind,
        author,
        bot: r.user?.type === 'Bot' || author.endsWith('[bot]'),
        ...(str(r.author_association) ? { association: str(r.author_association) } : {}),
        ...(kind === 'review' ? { state: str(r.state) } : {}),
        ...(kind === 'review-comment' && str(r.path) ? { path: str(r.path) } : {}),
        url,
        at,
      });
    };
    // A full comment page may have more after its last item: claim nothing past it.
    let until: number | undefined;
    for (const [stream, kind] of [
      [comments.items, 'comment'],
      [reviewComments.items, 'review-comment'],
    ] as const) {
      for (const c of stream) add(c, kind);
      if (stream.length >= PER_PAGE) {
        const lastAt = Date.parse(str((stream[stream.length - 1] as Raw)?.created_at) ?? '');
        if (Number.isFinite(lastAt)) until = until === undefined ? lastAt : Math.min(until, lastAt);
      }
    }
    for (const r of reviews) {
      const at = Date.parse(str((r as Raw)?.submitted_at) ?? '');
      if (Number.isFinite(at) && at > sinceMs) add(r, 'review');
    }
    const untilIso =
      until === undefined
        ? undefined
        : (out.find((i) => Date.parse(i.at) === until)?.at ?? new Date(until).toISOString());
    return { items: out, ...(untilIso ? { until: untilIso } : {}) };
  } catch (error) {
    logger.debug('Failed to read PR activity for the PR watch', {
      owner,
      repo,
      number,
      error: (error as Error).message,
    });
    return undefined;
  }
}

/**
 * #832 — what GitHub says about one PR or issue, for the write receipt (`github-receipt.ts`): when it was created,
 * merged and closed, its head branch and title, and GitHub's clock (`Date`). Undefined on any failure; never throws.
 * A 5-second cap: the receipt runs after the tool result and must not pile up.
 */
export async function fetchGitHubReceiptObject(
  owner: string,
  repo: string,
  kind: 'pr' | 'issue',
  number: number,
): Promise<GitHubReceiptObject | undefined> {
  try {
    const token = await getGitHubToken();
    if (!token) return undefined;
    const path = kind === 'pr' ? 'pulls' : 'issues';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), 5_000);
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}/${number}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) return undefined;
      const date = Date.parse(response.headers.get('date') ?? '');
      const data = (await response.json()) as {
        created_at?: unknown;
        merged_at?: unknown;
        closed_at?: unknown;
        state?: unknown;
        title?: unknown;
        head?: { ref?: unknown };
        pull_request?: unknown;
      };
      // The issues endpoint also answers for a PR number: an issue receipt is not a PR's.
      if (kind === 'issue' && data.pull_request) return undefined;
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      return {
        createdAt: str(data.created_at),
        mergedAt: str(data.merged_at) ?? null,
        closedAt: str(data.closed_at) ?? null,
        state: str(data.state),
        headRef: str(data.head?.ref),
        title: str(data.title),
        ...(Number.isFinite(date) ? { serverNowMs: date } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    logger.debug('Failed to fetch the GitHub write receipt', { owner, repo, number, error: (error as Error).message });
    return undefined;
  }
}
