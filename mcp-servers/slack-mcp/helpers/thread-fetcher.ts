/**
 * Thread fetching utilities for Slack conversations.replies API.
 */
import type { WebClient } from '@slack/web-api';

/** Extract pagination cursor from Slack API response. */
export function extractCursor(response: { response_metadata?: { next_cursor?: string } }): string | undefined {
  const c = response.response_metadata?.next_cursor;
  return c && c.length > 0 ? c : undefined;
}

/**
 * Get total message count in thread (root + replies).
 */
export async function getTotalCount(
  slack: WebClient,
  channel: string,
  threadTs: string,
  logger: { warn(msg: string, data?: any): void }
): Promise<number> {
  try {
    const response = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit: 1,
    });
    const root = response.messages?.[0];
    if (root && root.ts === threadTs) {
      const replyCount = (root as any).reply_count ?? 0;
      return replyCount + 1;
    }
    return 1;
  } catch (error) {
    logger.warn('Failed to get thread total count', error);
    return 0;
  }
}

/**
 * Fetch a slice of thread messages by offset and limit.
 */
export async function fetchThreadSlice(
  slack: WebClient,
  channel: string,
  threadTs: string,
  offset: number,
  limit: number,
  totalCount: number
): Promise<any[]> {
  if (totalCount === 0 || offset >= totalCount) return [];

  const collected: any[] = [];
  let cursor: string | undefined;
  let currentIndex = 0;

  do {
    const response = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
      cursor,
    });

    const msgs = response.messages || [];
    for (const m of msgs) {
      if (currentIndex >= offset && currentIndex < offset + limit) {
        collected.push(m);
      }
      currentIndex++;
      if (collected.length >= limit) break;
    }

    cursor = extractCursor(response);
    if (collected.length >= limit) break;
    if (currentIndex >= offset + limit) break;
  } while (cursor);

  return collected;
}

/**
 * Fetch up to `count` replies ending at (and including) anchorTs.
 */
export async function fetchMessagesBefore(
  slack: WebClient,
  channel: string,
  threadTs: string,
  anchorTs: string,
  count: number
): Promise<any[]> {
  if (count === 0) return [];

  const collected: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
      cursor,
    });

    const msgs = response.messages || [];
    for (const m of msgs) {
      if (m.ts === threadTs) continue;
      if (m.ts! > anchorTs) break;
      collected.push(m);
    }

    cursor = extractCursor(response);
    if (msgs.length > 0 && msgs[msgs.length - 1].ts! > anchorTs) break;
  } while (cursor);

  return collected.slice(-count);
}

/**
 * Fetch up to `count` replies starting after anchorTs (exclusive).
 */
export async function fetchMessagesAfter(
  slack: WebClient,
  channel: string,
  threadTs: string,
  anchorTs: string,
  count: number
): Promise<any[]> {
  const collected: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await slack.conversations.replies({
      channel,
      ts: threadTs,
      oldest: anchorTs,
      inclusive: false,
      limit: Math.min(count + 1, 200),
      cursor,
    });

    const msgs = response.messages || [];
    for (const m of msgs) {
      if (m.ts === threadTs) continue;
      collected.push(m);
      if (collected.length >= count) break;
    }

    cursor = extractCursor(response);
    if (collected.length >= count) break;
  } while (cursor);

  return collected.slice(0, count);
}
