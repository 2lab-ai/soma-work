/**
 * ChannelDescriptionCache — In-memory cache for Slack channel descriptions.
 * Used for system prompt injection (Feature 3) and channel registry (Feature 4).
 */

import { Logger } from './logger';

const logger = new Logger('ChannelDescriptionCache');

interface CachedDescription {
  description: string;
  purpose: string;
  topic: string;
  fetchedAt: number;
}

const cache = new Map<string, CachedDescription>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_DESCRIPTION_LENGTH = 500;

type SlackClient = {
  conversations: {
    info: (params: { channel: string }) => Promise<{
      channel?: {
        purpose?: { value?: string };
        topic?: { value?: string };
        name?: string;
      };
    }>;
  };
};

/**
 * Get channel description with caching.
 * Returns combined purpose + topic, or empty string for DMs.
 */
export async function getChannelDescription(
  client: SlackClient,
  channelId: string
): Promise<string> {
  // Skip DM channels
  if (channelId.startsWith('D')) return '';

  // Check cache
  const cached = cache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.description;
  }

  try {
    const result = await client.conversations.info({ channel: channelId });
    const channel = result.channel;

    const purpose = channel?.purpose?.value || '';
    const topic = channel?.topic?.value || '';

    // Combine purpose and topic
    const parts: string[] = [];
    if (purpose) parts.push(purpose);
    if (topic && topic !== purpose) parts.push(topic);
    const raw = parts.join('\n').trim();

    // Truncate and sanitize
    const description = sanitize(raw).substring(0, MAX_DESCRIPTION_LENGTH);

    cache.set(channelId, {
      description,
      purpose,
      topic,
      fetchedAt: Date.now(),
    });

    return description;
  } catch (error) {
    logger.debug('Failed to fetch channel description', {
      channelId,
      error: (error as Error).message,
    });
    return '';
  }
}

/**
 * Strip XML-like tags to prevent prompt injection, but preserve Slack link syntax.
 * Slack links: <https://...>, <@U123>, <#C123|name>
 */
function sanitize(text: string): string {
  // Preserve Slack-formatted links/mentions, strip everything else that looks like XML tags
  return text.replace(/<(\/?)([^>]+)>/g, (_match, slash, content) => {
    // Preserve Slack links (http/https URLs)
    if (content.startsWith('http://') || content.startsWith('https://')) return _match;
    // Preserve Slack user mentions (<@U123>)
    if (content.startsWith('@')) return _match;
    // Preserve Slack channel references (<#C123|name>)
    if (content.startsWith('#')) return _match;
    // Strip everything else (XML/HTML tags, prompt injection attempts)
    return '';
  });
}

/**
 * Invalidate cache for a specific channel.
 */
export function invalidateChannelCache(channelId: string): void {
  cache.delete(channelId);
}

/**
 * Clear all cached descriptions.
 */
export function clearChannelCache(): void {
  cache.clear();
}
