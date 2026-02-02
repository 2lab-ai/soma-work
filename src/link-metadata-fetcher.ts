/**
 * LinkMetadataFetcher - Fetches titles for session links (GitHub PRs, Jira issues)
 * Uses in-memory cache with TTL to minimize API calls.
 */

import { SessionLink } from './types';
import { config } from './config';
import { Logger } from './logger';

const logger = new Logger('LinkMetadataFetcher');

// Cache: url -> { title, fetchedAt }
const titleCache = new Map<string, { title: string; fetchedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_TITLE_LENGTH = 40;

/**
 * Fetch title for a link if not already cached/set.
 * Returns the title or undefined if unavailable.
 */
export async function fetchLinkTitle(link: SessionLink): Promise<string | undefined> {
  if (link.title) return link.title;

  // Check cache
  const cached = titleCache.get(link.url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.title;
  }

  try {
    let title: string | undefined;

    if (link.provider === 'github') {
      title = await fetchGitHubTitle(link);
    } else if (link.provider === 'jira') {
      title = await fetchJiraTitle(link);
    }

    if (title) {
      const truncated = truncateTitle(title, MAX_TITLE_LENGTH);
      titleCache.set(link.url, { title: truncated, fetchedAt: Date.now() });
      return truncated;
    }
  } catch (error) {
    logger.debug('Failed to fetch link title', { url: link.url, error: (error as Error).message });
  }

  return undefined;
}

/**
 * Fetch GitHub PR or issue title from API.
 * Parses URL pattern: https://github.com/{owner}/{repo}/pull/{number}
 *                  or: https://github.com/{owner}/{repo}/issues/{number}
 */
async function fetchGitHubTitle(link: SessionLink): Promise<string | undefined> {
  const token = config.github.token;
  if (!token) return undefined;

  const match = link.url.match(/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
  if (!match) return undefined;

  const [, owner, repo, type, number] = match;
  const apiPath = type === 'pull' ? 'pulls' : 'issues';

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/${apiPath}/${number}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Claude-Code-Slack-Bot/1.0.0',
    },
  });

  if (!response.ok) return undefined;

  const data = await response.json() as { title?: string };
  return data.title;
}

/**
 * Fetch Jira issue title from REST API.
 * Requires JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN environment variables.
 * Parses URL pattern: https://{domain}/browse/{issueKey}
 */
async function fetchJiraTitle(link: SessionLink): Promise<string | undefined> {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) return undefined;

  // Extract issue key from URL or label
  const issueKey = link.label || extractJiraKey(link.url);
  if (!issueKey) return undefined;

  const response = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}?fields=summary`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) return undefined;

  const data = await response.json() as { fields?: { summary?: string } };
  return data.fields?.summary;
}

function extractJiraKey(url: string): string | undefined {
  const match = url.match(/\/browse\/([A-Z]+-\d+)/);
  return match?.[1];
}

function truncateTitle(title: string, maxLen: number): string {
  if (title.length <= maxLen) return title;
  return title.substring(0, maxLen - 1) + '…';
}
