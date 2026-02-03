/**
 * LinkMetadataFetcher - Fetches titles and statuses for session links (GitHub PRs, Jira issues)
 * Uses in-memory cache with TTL to minimize API calls.
 */

import { SessionLink } from './types';
import { config } from './config';
import { getGitHubAppAuth } from './github-auth';
import { Logger } from './logger';

const logger = new Logger('LinkMetadataFetcher');

interface LinkMetadata {
  title?: string;
  status?: string;
  fetchedAt: number;
}

// Cache: url -> metadata
const metadataCache = new Map<string, LinkMetadata>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_TITLE_LENGTH = 40;

// Status emoji mapping
const STATUS_EMOJI: Record<string, string> = {
  // Jira statuses
  'to do': '⬜', 'open': '⬜', 'backlog': '⬜',
  'in progress': '🔵', 'in development': '🔵',
  'in review': '🟡', 'review': '🟡',
  'done': '✅', 'closed': '✅', 'resolved': '✅',
  // GitHub PR statuses
  'pr:open': '🟢', 'pr:draft': '⚪', 'pr:merged': '🟣', 'pr:closed': '🔴',
  // GitHub issue statuses
  'issue:open': '🟢', 'issue:closed': '✅',
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

    const truncatedTitle = metadata.title ? truncateTitle(metadata.title, MAX_TITLE_LENGTH) : undefined;
    metadataCache.set(link.url, {
      title: truncatedTitle,
      status: metadata.status,
      fetchedAt: Date.now(),
    });

    return { title: truncatedTitle || link.title, status: metadata.status || link.status };
  } catch (error) {
    logger.warn('Failed to fetch link metadata', { url: link.url, error: (error as Error).message });
    // Return existing data on failure (graceful degradation)
    return { title: link.title, status: link.status };
  }
}

/**
 * Convenience wrapper - fetch title only (backward compatible)
 */
export async function fetchLinkTitle(link: SessionLink): Promise<string | undefined> {
  if (link.title) return link.title;
  const metadata = await fetchLinkMetadata(link);
  return metadata.title;
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

  const data = await response.json() as {
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

  const data = await response.json() as {
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

export function extractJiraKey(url: string): string | undefined {
  const match = url.match(/\/browse\/([A-Z]+-\d+)/);
  return match?.[1];
}

export function extractGitHubPRInfo(url: string): { owner: string; repo: string; number: number } | undefined {
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

    const data = await response.json() as {
      transitions?: Array<{
        id: string;
        name: string;
        to?: { name?: string; statusCategory?: { key?: string } };
      }>;
    };

    return (data.transitions || []).map(t => ({
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
  head: string;   // source branch
  base: string;   // target branch
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
    const response = await fetch(
      `https://api.github.com/repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.number}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
        },
      }
    );

    if (!response.ok) return undefined;

    const data = await response.json() as {
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

function truncateTitle(title: string, maxLen: number): string {
  if (title.length <= maxLen) return title;
  return title.substring(0, maxLen - 1) + '…';
}
