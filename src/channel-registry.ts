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

export type RepoChannelMatchReason = 'no_repo' | 'no_mapping' | 'matched' | 'mismatch';

export interface RepoChannelMatchResult {
  correct: boolean;
  suggestedChannels: ChannelInfo[];
  reason: RepoChannelMatchReason;
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

    logger.info('🔍 Starting channel scan for repo mapping');

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
        const rawText = `${info.purpose}\n${info.topic}`;
        info.repos = parseRepos(rawText);

        if (info.repos.length > 0) {
          logger.info('📦 Channel has repo mapping', {
            channelId: channel.id,
            channelName: info.name,
            repos: info.repos,
            purpose: info.purpose.substring(0, 100),
            topic: info.topic.substring(0, 100),
          });
        }

        channels.set(channel.id, info);
        totalChannels++;
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Rebuild repo→channel index
    rebuildRepoIndex();

    logger.info('✅ Channel scan complete', {
      totalChannels,
      channelsWithRepos: [...channels.values()].filter(c => c.repos.length > 0).length,
      repoMappings: [...repoToChannels.entries()].map(([repo, chs]) =>
        `${repo} → [${chs.map(id => channels.get(id)?.name || id).join(', ')}]`
      ),
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
    logger.info('📝 Registering channel', { channelId });
    const result = await client.conversations.info({ channel: channelId });
    const channel = result.channel as any;
    if (!channel) {
      logger.warn('Channel info returned null', { channelId });
      return null;
    }

    const info: ChannelInfo = {
      id: channelId,
      name: channel.name || '',
      purpose: channel.purpose?.value || '',
      topic: channel.topic?.value || '',
      repos: [],
      joinedAt: Date.now(),
    };

    const rawText = `${info.purpose}\n${info.topic}`;
    info.repos = parseRepos(rawText);

    channels.set(channelId, info);
    rebuildRepoIndex();
    invalidateChannelCache(channelId);

    logger.info('✅ Channel registered', {
      channelId,
      name: info.name,
      repos: info.repos,
      purpose: info.purpose.substring(0, 100),
      topic: info.topic.substring(0, 100),
      totalChannels: channels.size,
      totalRepoMappings: repoToChannels.size,
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
  const result = repoToChannels.get(normalized) || [];

  logger.debug('🔎 findChannelsForRepo', {
    input: repoFullName,
    normalized,
    matchedChannels: result.map(id => ({ id, name: channels.get(id)?.name })),
    totalRepoMappings: repoToChannels.size,
    allMappedRepos: [...repoToChannels.keys()],
  });

  return result;
}

/**
 * Extract repo owner/name from a GitHub URL.
 */
export function extractRepoFromUrl(url: string): string | null {
  const match = url.match(/github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)/);
  if (!match) {
    logger.debug('🔗 extractRepoFromUrl: no match', { url });
    return null;
  }
  const repo = match[1].replace(/\.git$/, '').toLowerCase();
  logger.debug('🔗 extractRepoFromUrl', { url, repo });
  return repo;
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
): RepoChannelMatchResult {
  const currentChannelInfo = channels.get(currentChannel);

  logger.info('🧭 checkRepoChannelMatch START', {
    prUrl,
    currentChannel,
    currentChannelName: currentChannelInfo?.name || '(unknown)',
    registrySize: channels.size,
    repoMappingSize: repoToChannels.size,
  });

  const repo = extractRepoFromUrl(prUrl);
  if (!repo) {
    logger.info('🧭 checkRepoChannelMatch → correct (no repo extracted from URL)', { prUrl });
    return { correct: true, suggestedChannels: [], reason: 'no_repo' };
  }

  const mappedChannelIds = findChannelsForRepo(repo);

  // No mapping exists — treat as unresolved and let caller decide fallback.
  if (mappedChannelIds.length === 0) {
    logger.info('🧭 checkRepoChannelMatch → no mapping for repo', {
      repo,
      currentChannel,
      currentChannelName: currentChannelInfo?.name,
    });
    return { correct: false, suggestedChannels: [], reason: 'no_mapping' };
  }

  // Current channel is in the mapped channels
  if (mappedChannelIds.includes(currentChannel)) {
    logger.info('🧭 checkRepoChannelMatch → correct (current channel matches)', {
      repo,
      currentChannel,
      currentChannelName: currentChannelInfo?.name,
      mappedChannels: mappedChannelIds.map(id => ({ id, name: channels.get(id)?.name })),
    });
    return { correct: true, suggestedChannels: [], reason: 'matched' };
  }

  // Wrong channel — suggest the correct ones, sorted by repo count ascending
  // (fewer repos = more specialized channel = higher priority)
  const suggestedChannels = mappedChannelIds
    .map(id => channels.get(id))
    .filter((ch): ch is ChannelInfo => ch !== undefined)
    .sort((a, b) => a.repos.length - b.repos.length);

  logger.info('🧭 checkRepoChannelMatch → WRONG CHANNEL', {
    repo,
    currentChannel,
    currentChannelName: currentChannelInfo?.name,
    suggestedChannels: suggestedChannels.map(ch => ({ id: ch.id, name: ch.name, repoCount: ch.repos.length })),
  });

  return { correct: false, suggestedChannels, reason: 'mismatch' };
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
      logger.debug('📎 parseRepos: found repo', {
        repo,
        pattern: pattern.source,
        matchedText: match[0],
      });
    }
  }

  if (repos.size === 0 && text.trim().length > 0) {
    logger.debug('📎 parseRepos: no repos found in text', {
      textPreview: text.substring(0, 150),
      patterns: REPO_PATTERNS.map(p => p.source),
    });
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
  logger.info('🗂️ Repo index rebuilt', {
    repos: repoCount,
    totalChannels: channels.size,
    mappings: [...repoToChannels.entries()].map(([repo, chs]) =>
      `${repo} → [${chs.map(id => channels.get(id)?.name || id).join(', ')}]`
    ),
  });
}
