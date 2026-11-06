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

import type { WebClient } from '@slack/web-api';
import { Logger } from '@soma/common/logger';
import { invalidateChannelCache } from './channel-description-cache';

const logger = new Logger('ChannelRegistry');

export interface ChannelInfo {
  id: string;
  name: string;
  purpose: string;
  topic: string;
  repos: string[]; // Parsed repo URLs/names (e.g., "owner/repo")
  confluenceUrl?: string; // First Confluence wiki URL found in purpose/topic
  joinedAt: number;
  /** Private channel (Slack `is_private`); undefined when the source did not say. */
  isPrivate?: boolean;
  /** Archived (Slack `is_archived`): a channel the bot is still a member of, but no work can go there. */
  isArchived?: boolean;
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
/**
 * #970 — how long an entry the bot wrote itself (upsertChannel: a channel it just made and described) outranks a
 * read from Slack that has no repo in it. Slack can answer a read right after a write with the old purpose; that
 * stale answer must not erase the mapping. A removal ends it (unregisterChannel), so a real rejoin reads afresh.
 */
const MAKER_ENTRY_MS = 2 * 60_000;
const makerEntryUntil = new Map<string, number>();

/**
 * Store what a Slack read says about a channel. A read with no repo landing on an entry the bot wrote moments ago
 * that has one (#970) keeps that entry's description — purpose, topic, repos, wiki — and takes everything else
 * from the read (name, private, archived: those are as fresh as the read is). Returns the entry stored.
 */
function storeRead(info: ChannelInfo, client?: WebClient): ChannelInfo {
  const held = channels.get(info.id);
  const until = makerEntryUntil.get(info.id) ?? 0;
  if (held && Date.now() < until && held.repos.length > 0 && info.repos.length === 0) {
    // The read may also have been right (the repo link was really removed): read once more when the window ends.
    if (client) scheduleRecheck(client, info.id, until);
    const merged: ChannelInfo = {
      ...info,
      purpose: held.purpose,
      topic: held.topic,
      repos: held.repos,
      confluenceUrl: held.confluenceUrl,
    };
    logger.info('🛡️ Kept the maker’s description over a read with no repo (likely stale)', {
      channelId: info.id,
      repos: held.repos,
    });
    channels.set(info.id, merged);
    return merged;
  }
  channels.set(info.id, info);
  return info;
}

/** One pending re-read per channel whose repo-less read was kept out (#970). */
const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Bumped whenever the bot itself writes or drops a channel's entry: a re-read started before it is void. */
const entryGenerations = new Map<string, number>();
const RECHECK_RETRIES = 3;
const RECHECK_RETRY_MS = 60_000;

function bumpGeneration(channelId: string): void {
  entryGenerations.set(channelId, (entryGenerations.get(channelId) ?? 0) + 1);
}

/** A ChannelInfo from a Slack conversation object. */
function channelInfoFrom(channelId: string, channel: any): ChannelInfo {
  const info: ChannelInfo = {
    id: channelId,
    name: channel.name || '',
    purpose: channel.purpose?.value || '',
    topic: channel.topic?.value || '',
    repos: [],
    joinedAt: Date.now(),
    isPrivate: channel.is_private === true,
    isArchived: channel.is_archived === true,
  };
  const rawText = `${info.purpose}\n${info.topic}`;
  info.repos = parseRepos(rawText);
  info.confluenceUrl = parseConfluenceUrl(rawText);
  return info;
}

/**
 * After the maker's window ends, read the channel again and take what Slack says then — so a repo link removed on
 * purpose inside the window is not kept forever. The bot's own write or removal since (its generation moved) voids
 * it — checked again once the read answers, so an answer arriving late never resurrects or overwrites. A read that
 * fails is retried (RECHECK_RETRIES, a minute apart); the kept entry stays until one answers.
 */
function scheduleRecheck(client: WebClient, channelId: string, until: number, attempt = 0): void {
  if (recheckTimers.has(channelId)) return;
  const generation = entryGenerations.get(channelId) ?? 0;
  const current = () => channels.has(channelId) && (entryGenerations.get(channelId) ?? 0) === generation;
  const delay = attempt === 0 ? Math.max(0, until - Date.now()) + 1_000 : RECHECK_RETRY_MS * attempt;
  const timer = setTimeout(async () => {
    recheckTimers.delete(channelId);
    if (!current()) return;
    let channel: any;
    try {
      channel = (await client.conversations.info({ channel: channelId })).channel;
    } catch (error) {
      logger.warn('Re-read after the maker’s window failed', { channelId, attempt, error: (error as Error).message });
    }
    if (!current()) return;
    if (!channel) {
      if (attempt < RECHECK_RETRIES) scheduleRecheck(client, channelId, until, attempt + 1);
      return;
    }
    makerEntryUntil.delete(channelId);
    channels.set(channelId, channelInfoFrom(channelId, channel));
    rebuildRepoIndex();
    invalidateChannelCache(channelId);
    logger.info('🔁 Re-read a channel after the maker’s window', { channelId, repos: channels.get(channelId)?.repos });
  }, delay);
  (timer as { unref?: () => void }).unref?.();
  recheckTimers.set(channelId, timer);
}

function clearRecheck(channelId: string): void {
  const timer = recheckTimers.get(channelId);
  if (timer) clearTimeout(timer);
  recheckTimers.delete(channelId);
}

// Repo detection pattern: GitHub repo URLs or "repo: owner/repo" notation
const REPO_PATTERNS = [
  /github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)/gi,
  /\brepo:\s*([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)/gi,
  /\brepository:\s*([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+)/gi,
];

// Confluence wiki URL pattern
const CONFLUENCE_PATTERN = /https?:\/\/[a-zA-Z0-9_-]+\.atlassian\.net\/wiki\/[^\s<>)]+/gi;

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
          isPrivate: channel.is_private === true,
          isArchived: channel.is_archived === true,
        };

        // Parse repos and confluence URL from purpose + topic
        const rawText = `${info.purpose}\n${info.topic}`;
        info.repos = parseRepos(rawText);
        info.confluenceUrl = parseConfluenceUrl(rawText);

        if (info.repos.length > 0) {
          logger.info('📦 Channel has repo mapping', {
            channelId: channel.id,
            channelName: info.name,
            repos: info.repos,
            confluenceUrl: info.confluenceUrl,
            purpose: info.purpose.substring(0, 100),
            topic: info.topic.substring(0, 100),
          });
        }

        storeRead(info, client);
        totalChannels++;
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // Rebuild repo→channel index
    rebuildRepoIndex();

    logger.info('✅ Channel scan complete', {
      totalChannels,
      channelsWithRepos: [...channels.values()].filter((c) => c.repos.length > 0).length,
      repoMappings: [...repoToChannels.entries()].map(
        ([repo, chs]) => `${repo} → [${chs.map((id) => channels.get(id)?.name || id).join(', ')}]`,
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
export async function registerChannel(client: WebClient, channelId: string): Promise<ChannelInfo | null> {
  try {
    logger.info('📝 Registering channel', { channelId });
    const result = await client.conversations.info({ channel: channelId });
    const channel = result.channel as any;
    if (!channel) {
      logger.warn('Channel info returned null', { channelId });
      return null;
    }

    const info = channelInfoFrom(channelId, channel);
    const stored = storeRead(info, client);
    rebuildRepoIndex();
    invalidateChannelCache(channelId);
    if (stored !== info) return stored;

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
 * Register a channel from values the caller already holds — a channel the bot
 * has just made and described (the dashboard's new repo channel). No
 * `conversations.info` round trip: one made a moment ago may not read back its
 * purpose yet, and a stale read must not erase the repo mapping.
 */
export function upsertChannel(input: {
  id: string;
  name: string;
  purpose?: string;
  topic?: string;
  isPrivate?: boolean;
}): ChannelInfo {
  const info: ChannelInfo = {
    id: input.id,
    name: input.name,
    purpose: input.purpose ?? '',
    topic: input.topic ?? '',
    repos: [],
    joinedAt: Date.now(),
    isPrivate: input.isPrivate === true,
    isArchived: false,
  };
  const rawText = `${info.purpose}\n${info.topic}`;
  info.repos = parseRepos(rawText);
  info.confluenceUrl = parseConfluenceUrl(rawText);
  channels.set(info.id, info);
  makerEntryUntil.set(info.id, Date.now() + MAKER_ENTRY_MS);
  bumpGeneration(info.id);
  clearRecheck(info.id);
  rebuildRepoIndex();
  invalidateChannelCache(info.id);
  logger.info('✅ Channel upserted', { channelId: info.id, name: info.name, repos: info.repos });
  return info;
}

/**
 * #970 — a channel Slack says is archived (an invite answered `is_archived`, or a read): no work goes there any
 * more. The entry stays (the bot is still a member) but is marked, so the new-task flow passes it over.
 */
export function markChannelArchived(channelId: string): void {
  const info = channels.get(channelId);
  if (!info || info.isArchived === true) return;
  channels.set(channelId, { ...info, isArchived: true });
  logger.info('🗄️ Channel marked archived', { channelId, name: info.name });
}

/**
 * Channel names the bot is making right now (a dashboard task's new repo channel). Slack sends the bot's
 * `member_joined_channel` on creation too; while the name is here, that join is the maker's to register (it writes
 * the repo first), and the EventRouter leaves it alone. Any later join registers as usual.
 */
const channelsBeingMade = new Map<string, number>();

/** Mark `name` as being made; the returned function unmarks it (call it once the maker is done, either way). */
export function markChannelBeingMade(name: string): () => void {
  channelsBeingMade.set(name, (channelsBeingMade.get(name) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (channelsBeingMade.get(name) ?? 1) - 1;
    if (n > 0) channelsBeingMade.set(name, n);
    else channelsBeingMade.delete(name);
  };
}

export function isChannelBeingMade(name: string): boolean {
  return channelsBeingMade.has(name);
}

/**
 * Unregister a channel when bot leaves or is removed.
 */
export function unregisterChannel(channelId: string): void {
  channels.delete(channelId);
  makerEntryUntil.delete(channelId);
  bumpGeneration(channelId);
  clearRecheck(channelId);
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
    matchedChannels: result.map((id) => ({ id, name: channels.get(id)?.name })),
    totalRepoMappings: repoToChannels.size,
    allMappedRepos: [...repoToChannels.keys()],
  });

  return result;
}

/**
 * Extract repo owner/name from a GitHub URL.
 */
function extractRepoFromUrl(url: string): string | null {
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
export function checkRepoChannelMatch(prUrl: string, currentChannel: string): RepoChannelMatchResult {
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
      mappedChannels: mappedChannelIds.map((id) => ({ id, name: channels.get(id)?.name })),
    });
    return { correct: true, suggestedChannels: [], reason: 'matched' };
  }

  // Wrong channel — suggest the correct ones, sorted by repo count ascending
  // (fewer repos = more specialized channel = higher priority)
  const suggestedChannels = mappedChannelIds
    .map((id) => channels.get(id))
    .filter((ch): ch is ChannelInfo => ch !== undefined)
    .sort((a, b) => a.repos.length - b.repos.length);

  logger.info('🧭 checkRepoChannelMatch → WRONG CHANNEL', {
    repo,
    currentChannel,
    currentChannelName: currentChannelInfo?.name,
    suggestedChannels: suggestedChannels.map((ch) => ({ id: ch.id, name: ch.name, repoCount: ch.repos.length })),
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
      patterns: REPO_PATTERNS.map((p) => p.source),
    });
  }

  return [...repos];
}

function parseConfluenceUrl(text: string): string | undefined {
  CONFLUENCE_PATTERN.lastIndex = 0;
  const match = CONFLUENCE_PATTERN.exec(text);
  return match ? match[0] : undefined;
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
    mappings: [...repoToChannels.entries()].map(
      ([repo, chs]) => `${repo} → [${chs.map((id) => channels.get(id)?.name || id).join(', ')}]`,
    ),
  });
}
