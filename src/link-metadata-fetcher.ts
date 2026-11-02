/**
 * LinkMetadataFetcher - Fetches titles and statuses for session links (GitHub PRs, Jira issues)
 * Uses in-memory cache with TTL to minimize API calls.
 */

import { config } from './config';
import { getGitHubAppAuth } from './github-auth';
import { Logger } from './logger';
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
