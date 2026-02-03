/**
 * ChannelRegistry — Tracks all channels the bot is a member of,
 * and maps channels to repositories based on channel description/purpose.
 *
 * Features:
 * - Startup scan via conversations.list
 * - Real-time updates via member_joined_channel / channel_left events
 * - Parses channel descriptions for repo information
 * - Provides channel↔repo mapping for smart routing
 */

import { WebClient } from '@slack/web-api';
import { Logger } from './logger';
import { getChannelDescription, invalidateChannelCache } from './channel-description-cache';

const logger = new Logger('ChannelRegistry');

export interface ChannelInfo {
  id: string;
  name: string;
  purpose: string;
  topic: string;
  repos: string[];      // Parsed repo URLs/names (e.g., "owner/repo")
  joinedAt: number;
}

// Registry state
const channels = new Map<string, ChannelInfo>();
const repoToChannels = new Map<string, string[]>(); // repo → channel IDs

// Repo detection pattern: GitHub repo URLs or "repo: owner/repo" notation
const REPO_PATTERNS = [
  /github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)/gi,
  /\brepo:\s*([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)/gi,
  /\brepository:\s*([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)/gi,
];

/**
 * Scan all channels the bot is a member of.
 * Call at startup.
 */
export async function scanChannels(client: WebClient): Promise<number> {
  try {
    let cursor: string | undefined;
    let totalChannels = 0;

    do {
      const result = await client.conversations.list({
        types: 'public_channel,private_channel',
        limit: 200,
        cursor,
      });

      for (const channel of result.channels || []) {
        if (!channel.id || !channel.is_member) continue;

        const info: ChannelInfo = {
          id: channel.id,
          name: channel.name || '',
          purpose: (channel.purpose as any)?.value || '',
          topic: (channel.topic as any)?.value || '',
          repos: [],
          joinedAt: Date.now(),
        };

        // Parse repos from purpose + topic
        info.repos = parseRepos(`${info.purpose}\n${info.topic}`);

        channels.set(channel.id, info);
        totalChannels++;
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Rebuild repo→channel index
    rebuildRepoIndex();

    logger.info('Channel scan complete', {
      totalChannels,
      channelsWithRepos: [...channels.values()].filter(c => c.repos.length > 0).length,
    });

    return totalChannels;
  } catch (error) {
    logger.warn('Failed to scan channels', { error: (error as Error).message });
    return 0;
  }
}

/**
 * Register a channel when bot joins it.
 */
export async function registerChannel(
  client: WebClient,
  channelId: string
): Promise<ChannelInfo | null> {
  try {
    const result = await client.conversations.info({ channel: channelId });
    const channel = result.channel as any;
    if (!channel) return null;

    const info: ChannelInfo = {
      id: channelId,
      name: channel.name || '',
      purpose: channel.purpose?.value || '',
      topic: channel.topic?.value || '',
      repos: [],
      joinedAt: Date.now(),
    };

    info.repos = parseRepos(`${info.purpose}\n${info.topic}`);

    channels.set(channelId, info);
    rebuildRepoIndex();
    invalidateChannelCache(channelId);

    logger.info('Channel registered', {
      channelId,
      name: info.name,
      repos: info.repos,
    });

    return info;
  } catch (error) {
    logger.warn('Failed to register channel', {
      channelId,
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Unregister a channel when bot leaves or is removed.
 */
export function unregisterChannel(channelId: string): void {
  channels.delete(channelId);
  rebuildRepoIndex();
  invalidateChannelCache(channelId);
  logger.info('Channel unregistered', { channelId });
}

/**
 * Find the correct channel for a given repo.
 * Returns the channel ID(s) mapped to this repo, or empty array.
 */
export function findChannelsForRepo(repoFullName: string): string[] {
  // Normalize: lowercase, strip .git suffix
  const normalized = repoFullName.toLowerCase().replace(/\.git$/, '');
  return repoToChannels.get(normalized) || [];
}

/**
 * Extract repo owner/name from a GitHub URL.
 */
export function extractRepoFromUrl(url: string): string | null {
  const match = url.match(/github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)/);
  if (!match) return null;
  return match[1].replace(/\.git$/, '').toLowerCase();
}

/**
 * Get channel info from registry.
 */
export function getChannel(channelId: string): ChannelInfo | undefined {
  return channels.get(channelId);
}

/**
 * Get all registered channels.
 */
export function getAllChannels(): ChannelInfo[] {
  return [...channels.values()];
}

/**
 * Check if a PR URL belongs to the correct channel.
 * Returns: { correct: true } or { correct: false, suggestedChannels: [...] }
 */
export function checkRepoChannelMatch(
  prUrl: string,
  currentChannel: string
): { correct: boolean; suggestedChannels: ChannelInfo[] } {
  const repo = extractRepoFromUrl(prUrl);
  if (!repo) return { correct: true, suggestedChannels: [] };

  const mappedChannelIds = findChannelsForRepo(repo);

  // No mapping exists — assume correct (no registry data)
  if (mappedChannelIds.length === 0) return { correct: true, suggestedChannels: [] };

  // Current channel is in the mapped channels
  if (mappedChannelIds.includes(currentChannel)) {
    return { correct: true, suggestedChannels: [] };
  }

  // Wrong channel — suggest the correct ones
  const suggestedChannels = mappedChannelIds
    .map(id => channels.get(id))
    .filter((ch): ch is ChannelInfo => ch !== undefined);

  return { correct: false, suggestedChannels };
}

// --- Internal helpers ---

function parseRepos(text: string): string[] {
  const repos = new Set<string>();

  for (const pattern of REPO_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const repo = match[1].replace(/\.git$/, '').toLowerCase();
      repos.add(repo);
    }
  }

  return [...repos];
}

function rebuildRepoIndex(): void {
  repoToChannels.clear();

  for (const [channelId, info] of channels) {
    for (const repo of info.repos) {
      const existing = repoToChannels.get(repo) || [];
      if (!existing.includes(channelId)) {
        existing.push(channelId);
        repoToChannels.set(repo, existing);
      }
    }
  }

  const repoCount = repoToChannels.size;
  if (repoCount > 0) {
    logger.debug('Repo index rebuilt', {
      repos: repoCount,
      mappings: [...repoToChannels.entries()].map(([repo, chs]) => `${repo} → ${chs.length} channels`),
    });
  }
}
