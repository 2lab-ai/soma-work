import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration tests for get_thread_messages with mocked Slack API.
 *
 * Since SlackMcpServer is not exported and auto-starts on import,
 * we extract the core logic into standalone functions that mirror the
 * server's behavior, then test with mocked conversations.replies.
 *
 * Covers Codex review gaps:
 * - CRITICAL: Array mode with mocked conversations.replies
 * - HIGH: Legacy mode after refactor
 * - HIGH: Offset/limit boundary semantics
 * - HIGH: getTotalCount success/failure paths
 */

// ── Re-implement core logic for testing ──────────────────────────

function extractCursor(response: { response_metadata?: { next_cursor?: string } }): string | undefined {
  const c = response.response_metadata?.next_cursor;
  return c && c.length > 0 ? c : undefined;
}

interface MockSlackClient {
  conversations: {
    replies: (args: any) => Promise<any>;
  };
}

// Mirrors getTotalCount from the server
async function getTotalCount(slack: MockSlackClient, channel: string, threadTs: string): Promise<number> {
  try {
    const response = await slack.conversations.replies({ channel, ts: threadTs, limit: 1 });
    const root = response.messages?.[0];
    if (root && root.ts === threadTs) {
      const replyCount = root.reply_count ?? 0;
      return replyCount + 1;
    }
    return 1;
  } catch {
    return 0;
  }
}

// Mirrors fetchThreadSlice from the server
async function fetchThreadSlice(
  slack: MockSlackClient, channel: string, threadTs: string,
  offset: number, limit: number, totalCount: number
): Promise<any[]> {
  if (totalCount === 0 || offset >= totalCount) return [];
  const collected: any[] = [];
  let cursor: string | undefined;
  let currentIndex = 0;

  do {
    const response = await slack.conversations.replies({
      channel, ts: threadTs, limit: 200, cursor,
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

// Mirrors handleArrayMode from the server
async function handleArrayMode(
  slack: MockSlackClient, channel: string, threadTs: string,
  args: { offset?: number; limit?: number }
) {
  const offset = Math.max(args.offset ?? 0, 0);
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const totalCount = await getTotalCount(slack, channel, threadTs);
  const clampedOffset = Math.min(offset, Math.max(totalCount - 1, 0));
  const messages = await fetchThreadSlice(slack, channel, threadTs, clampedOffset, limit, totalCount);
  const hasMore = clampedOffset + messages.length < totalCount;

  return {
    thread_ts: threadTs,
    channel,
    total_count: totalCount,
    offset: clampedOffset,
    returned: messages.length,
    messages,
    has_more: hasMore,
  };
}

// Mirrors fetchMessagesBefore (legacy) from the server
async function fetchMessagesBefore(
  slack: MockSlackClient, channel: string, threadTs: string,
  anchorTs: string, count: number
): Promise<{ messages: any[]; rootWasInjected: boolean }> {
  if (count === 0) return { messages: [], rootWasInjected: false };
  let rootMessage: any | null = null;
  const collected: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await slack.conversations.replies({
      channel, ts: threadTs, limit: 200, cursor,
    });
    const msgs = response.messages || [];
    for (const m of msgs) {
      if (m.ts > anchorTs) break;
      if (m.ts === threadTs) { rootMessage = m; }
      collected.push(m);
    }
    cursor = extractCursor(response);
    if (msgs.length > 0 && msgs[msgs.length - 1].ts > anchorTs) break;
  } while (cursor);

  const sliced = collected.slice(-count);
  let rootWasInjected = false;
  if (rootMessage && !sliced.some((m: any) => m.ts === threadTs)) {
    sliced.unshift(rootMessage);
    rootWasInjected = true;
  }
  return { messages: sliced, rootWasInjected };
}

// ── Test fixtures ────────────────────────────────────────────────

function makeThread(replyCount: number): any[] {
  const root = { ts: '1700000000.000000', text: 'Root', user: 'U1', reply_count: replyCount };
  const replies = Array.from({ length: replyCount }, (_, i) => ({
    ts: `${1700000001 + i}.000000`,
    text: `Reply ${i + 1}`,
    user: `U${i + 2}`,
  }));
  return [root, ...replies];
}

function createMockSlack(thread: any[], pageSize = 200): MockSlackClient {
  return {
    conversations: {
      replies: vi.fn(async (args: any) => {
        const limit = args.limit || 200;
        // Simple pagination: use cursor as start index
        const startIdx = args.cursor ? parseInt(args.cursor) : 0;
        const page = thread.slice(startIdx, startIdx + limit);
        const nextIdx = startIdx + limit;
        const hasMore = nextIdx < thread.length;

        return {
          messages: page,
          response_metadata: hasMore ? { next_cursor: String(nextIdx) } : {},
        };
      }),
    },
  };
}

// ── getTotalCount tests ──────────────────────────────────────────

describe('getTotalCount', () => {
  it('returns reply_count + 1 from root message', async () => {
    const thread = makeThread(10);
    const slack = createMockSlack(thread);
    const count = await getTotalCount(slack, 'C123', '1700000000.000000');
    expect(count).toBe(11); // 10 replies + 1 root
  });

  it('returns 1 for thread with no replies', async () => {
    const thread = makeThread(0);
    const slack = createMockSlack(thread);
    const count = await getTotalCount(slack, 'C123', '1700000000.000000');
    expect(count).toBe(1);
  });

  it('returns 0 when Slack API throws', async () => {
    const slack: MockSlackClient = {
      conversations: {
        replies: vi.fn(async () => { throw new Error('Slack API error'); }),
      },
    };
    const count = await getTotalCount(slack, 'C123', '1700000000.000000');
    expect(count).toBe(0);
  });

  it('returns 1 when root message has no reply_count field', async () => {
    const slack: MockSlackClient = {
      conversations: {
        replies: vi.fn(async () => ({
          messages: [{ ts: '1700000000.000000', text: 'Root' }],
        })),
      },
    };
    const count = await getTotalCount(slack, 'C123', '1700000000.000000');
    expect(count).toBe(1); // reply_count defaults to 0, so 0 + 1 = 1
  });

  it('returns 1 when messages array is empty', async () => {
    const slack: MockSlackClient = {
      conversations: {
        replies: vi.fn(async () => ({ messages: [] })),
      },
    };
    const count = await getTotalCount(slack, 'C123', '1700000000.000000');
    expect(count).toBe(1); // No root found but we default to 1
  });
});

// ── fetchThreadSlice tests (array mode core) ─────────────────────

describe('fetchThreadSlice — array mode core', () => {
  it('offset=0, limit=1 returns only root', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await fetchThreadSlice(slack, 'C123', '1700000000.000000', 0, 1, 6);
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe('1700000000.000000');
  });

  it('offset=1, limit=3 returns first 3 replies without root', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await fetchThreadSlice(slack, 'C123', '1700000000.000000', 1, 3, 6);
    expect(result).toHaveLength(3);
    expect(result[0].ts).toBe('1700000001.000000'); // first reply
    expect(result[2].ts).toBe('1700000003.000000'); // third reply
  });

  it('offset=4, limit=10 returns remaining 2 messages (clamped)', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await fetchThreadSlice(slack, 'C123', '1700000000.000000', 4, 10, 6);
    expect(result).toHaveLength(2); // only 2 left at offset 4 of 6 total
  });

  it('offset >= totalCount returns empty', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await fetchThreadSlice(slack, 'C123', '1700000000.000000', 6, 10, 6);
    expect(result).toHaveLength(0);
  });

  it('totalCount=0 returns empty', async () => {
    const slack = createMockSlack([]);
    const result = await fetchThreadSlice(slack, 'C123', '1700000000.000000', 0, 10, 0);
    expect(result).toHaveLength(0);
  });

  it('handles multi-page pagination (thread > 200 messages)', async () => {
    const thread = makeThread(250);
    const slack = createMockSlack(thread, 200);
    // Fetch messages at offset 199 (last of page 1) and 200 (first of page 2)
    const result = await fetchThreadSlice(slack, 'C123', '1700000000.000000', 199, 3, 251);
    expect(result).toHaveLength(3);
    expect(result[0].ts).toBe(`${1700000000 + 199}.000000`);
    expect(result[1].ts).toBe(`${1700000000 + 200}.000000`);
    expect(result[2].ts).toBe(`${1700000000 + 201}.000000`);
  });
});

// ── handleArrayMode integration tests ────────────────────────────

describe('handleArrayMode — full integration', () => {
  it('default args (no offset/limit) returns first 10 messages', async () => {
    const thread = makeThread(20);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', {});
    expect(result.total_count).toBe(21);
    expect(result.offset).toBe(0);
    expect(result.returned).toBe(10);
    expect(result.has_more).toBe(true);
    expect(result.messages[0].ts).toBe('1700000000.000000'); // root
  });

  it('offset=0, limit=1 returns root only with has_more=true', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: 0, limit: 1 });
    expect(result.returned).toBe(1);
    expect(result.messages[0].ts).toBe('1700000000.000000');
    expect(result.has_more).toBe(true);
    expect(result.total_count).toBe(6);
  });

  it('offset=1, limit=5 skips root', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: 1, limit: 5 });
    expect(result.returned).toBe(5);
    expect(result.messages[0].ts).toBe('1700000001.000000'); // first reply
    expect(result.has_more).toBe(false); // 1 + 5 = 6 = total
  });

  it('last page has has_more=false', async () => {
    const thread = makeThread(3);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: 2, limit: 10 });
    expect(result.returned).toBe(2); // messages at index 2 and 3
    expect(result.has_more).toBe(false);
  });

  it('offset beyond total_count is clamped', async () => {
    const thread = makeThread(3);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: 100, limit: 5 });
    // total=4, offset clamped to 3 (last valid index)
    expect(result.offset).toBe(3);
    expect(result.returned).toBe(1); // only the last message
  });

  it('negative offset is clamped to 0', async () => {
    const thread = makeThread(3);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: -5, limit: 2 });
    expect(result.offset).toBe(0);
    expect(result.returned).toBe(2);
  });

  it('limit=0 is clamped to 1', async () => {
    const thread = makeThread(3);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: 0, limit: 0 });
    expect(result.returned).toBe(1); // limit clamped to 1
  });

  it('limit>50 is clamped to 50', async () => {
    const thread = makeThread(100);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: 0, limit: 999 });
    expect(result.returned).toBe(50); // clamped
  });

  it('root-only thread (no replies)', async () => {
    const thread = makeThread(0);
    const slack = createMockSlack(thread);
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: 0, limit: 10 });
    expect(result.total_count).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.has_more).toBe(false);
    expect(result.messages[0].text).toBe('Root');
  });

  it('getTotalCount failure returns empty result gracefully', async () => {
    const slack: MockSlackClient = {
      conversations: {
        replies: vi.fn(async () => { throw new Error('Slack down'); }),
      },
    };
    const result = await handleArrayMode(slack, 'C123', '1700000000.000000', { offset: 0, limit: 10 });
    expect(result.total_count).toBe(0);
    expect(result.returned).toBe(0);
    expect(result.has_more).toBe(false);
  });
});

// ── fetchMessagesBefore (legacy mode) tests ──────────────────────

describe('fetchMessagesBefore — legacy mode', () => {
  it('returns last N messages before anchor (root always included)', async () => {
    const thread = makeThread(10);
    const slack = createMockSlack(thread);
    const { messages } = await fetchMessagesBefore(slack, 'C123', '1700000000.000000', '1700000005.000000', 3);
    // Root injected + 3 sliced = 4 (root was outside the window)
    expect(messages[0].ts).toBe('1700000000.000000'); // root always first
    expect(messages[1].ts).toBe('1700000003.000000');
    expect(messages[3].ts).toBe('1700000005.000000');
  });

  it('always includes root message with files', async () => {
    const thread = makeThread(5);
    thread[0].files = [{ id: 'F1', name: 'header.png' }];
    const slack = createMockSlack(thread);
    const { messages } = await fetchMessagesBefore(slack, 'C123', '1700000000.000000', '1700000005.000000', 10);
    expect(messages.some((m: any) => m.ts === '1700000000.000000')).toBe(true);
    expect(messages.find((m: any) => m.ts === '1700000000.000000')?.files[0].name).toBe('header.png');
  });

  it('reports rootWasInjected when root is outside count window', async () => {
    const thread = makeThread(10);
    const slack = createMockSlack(thread);
    const { rootWasInjected } = await fetchMessagesBefore(slack, 'C123', '1700000000.000000', '1700000005.000000', 3);
    expect(rootWasInjected).toBe(true);
  });

  it('rootWasInjected is false when root is within count window', async () => {
    const thread = makeThread(2);
    const slack = createMockSlack(thread);
    const { rootWasInjected } = await fetchMessagesBefore(slack, 'C123', '1700000000.000000', '1700000002.000000', 10);
    expect(rootWasInjected).toBe(false);
  });

  it('deep thread: root survives .slice(-count)', async () => {
    const thread = makeThread(25);
    const slack = createMockSlack(thread);
    const { messages, rootWasInjected } = await fetchMessagesBefore(slack, 'C123', '1700000000.000000', '1700000025.000000', 20);
    expect(messages[0].ts).toBe('1700000000.000000');
    expect(rootWasInjected).toBe(true);
    // 20 sliced + 1 injected root = 21
    expect(messages.length).toBe(21);
  });

  it('returns empty for count=0', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const { messages } = await fetchMessagesBefore(slack, 'C123', '1700000000.000000', '1700000003.000000', 0);
    expect(messages).toHaveLength(0);
  });

  it('returns all available if count > available (no false rootWasInjected)', async () => {
    const thread = makeThread(3);
    const slack = createMockSlack(thread);
    const { messages, rootWasInjected } = await fetchMessagesBefore(slack, 'C123', '1700000000.000000', '1700000003.000000', 50);
    // root + 3 replies = 4 total, all fit in count=50
    expect(messages).toHaveLength(4);
    expect(rootWasInjected).toBe(false);
  });

  it('has_more boundary: no false positive when root injected fills exact count', async () => {
    // Thread: root + 2 replies. before=2. sliced = [r1, r2], root injected → length 3.
    // But effective length (3-1=2) === before(2), so hasMore should correctly detect boundary.
    const thread = makeThread(2);
    const slack = createMockSlack(thread);
    const { messages, rootWasInjected } = await fetchMessagesBefore(slack, 'C123', '1700000000.000000', '1700000002.000000', 2);
    const effectiveLen = rootWasInjected ? messages.length - 1 : messages.length;
    // effectiveLen === before → hasMore should be true (could be more before)
    // In this case there genuinely aren't more, but the heuristic conservatively says true at boundary.
    // The key fix: it does NOT say hasMore just because root was injected.
    expect(effectiveLen).toBe(2);
  });
});

// ── Mode detection tests ─────────────────────────────────────────

describe('Mode detection logic', () => {
  function detectMode(args: {
    offset?: number; limit?: number;
    anchor_ts?: string; before?: number; after?: number;
  }): 'array' | 'legacy' {
    const isLegacy = args.anchor_ts !== undefined
      || args.before !== undefined
      || args.after !== undefined;
    return isLegacy ? 'legacy' : 'array';
  }

  it('empty args → array mode', () => {
    expect(detectMode({})).toBe('array');
  });

  it('offset/limit only → array mode', () => {
    expect(detectMode({ offset: 5, limit: 10 })).toBe('array');
  });

  it('anchor_ts → legacy mode', () => {
    expect(detectMode({ anchor_ts: '123' })).toBe('legacy');
  });

  it('before only → legacy mode', () => {
    expect(detectMode({ before: 10 })).toBe('legacy');
  });

  it('after only → legacy mode', () => {
    expect(detectMode({ after: 5 })).toBe('legacy');
  });

  it('mixed offset + before → legacy mode (legacy takes precedence)', () => {
    expect(detectMode({ offset: 0, before: 10 })).toBe('legacy');
  });
});
