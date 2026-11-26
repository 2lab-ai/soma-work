import { describe, expect, it, vi } from 'vitest';
import { fetchMessagesBefore, fetchThreadSlice, getTotalCount } from './helpers/thread-fetcher.js';

/**
 * The thread-fetching helpers behind get_thread_messages (helpers/thread-fetcher.ts), run against a
 * mocked conversations.replies:
 * - getTotalCount success/failure paths
 * - fetchThreadSlice offset/limit slicing and paging
 * - fetchMessagesBefore (legacy mode) with the root kept in front
 *
 * The tool's own clamping, has_more and mode choice are driven through the server's MCP handlers in
 * slack-mcp-contract.test.ts.
 */

type SlackClient = Parameters<typeof getTotalCount>[0];

interface MockSlackClient {
  conversations: {
    replies: (args: any) => Promise<any>;
  };
}

const asSlack = (mock: MockSlackClient): SlackClient => mock as unknown as SlackClient;

const silentLogger = { warn: vi.fn() };

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
    const count = await getTotalCount(asSlack(slack), 'C123', '1700000000.000000', silentLogger);
    expect(count).toBe(11); // 10 replies + 1 root
  });

  it('returns 1 for thread with no replies', async () => {
    const thread = makeThread(0);
    const slack = createMockSlack(thread);
    const count = await getTotalCount(asSlack(slack), 'C123', '1700000000.000000', silentLogger);
    expect(count).toBe(1);
  });

  it('returns 0 when Slack API throws', async () => {
    const slack: MockSlackClient = {
      conversations: {
        replies: vi.fn(async () => {
          throw new Error('Slack API error');
        }),
      },
    };
    const logger = { warn: vi.fn() };
    const count = await getTotalCount(asSlack(slack), 'C123', '1700000000.000000', logger);
    expect(count).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('Failed to get thread total count', expect.any(Error));
  });

  it('returns 1 when root message has no reply_count field', async () => {
    const slack: MockSlackClient = {
      conversations: {
        replies: vi.fn(async () => ({
          messages: [{ ts: '1700000000.000000', text: 'Root' }],
        })),
      },
    };
    const count = await getTotalCount(asSlack(slack), 'C123', '1700000000.000000', silentLogger);
    expect(count).toBe(1); // reply_count defaults to 0, so 0 + 1 = 1
  });

  it('returns 1 when messages array is empty', async () => {
    const slack: MockSlackClient = {
      conversations: {
        replies: vi.fn(async () => ({ messages: [] })),
      },
    };
    const count = await getTotalCount(asSlack(slack), 'C123', '1700000000.000000', silentLogger);
    expect(count).toBe(1); // No root found but we default to 1
  });
});

// ── fetchThreadSlice tests (array mode core) ─────────────────────

describe('fetchThreadSlice — array mode core', () => {
  it('offset=0, limit=1 returns only root', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await fetchThreadSlice(asSlack(slack), 'C123', '1700000000.000000', 0, 1, 6);
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe('1700000000.000000');
  });

  it('offset=1, limit=3 returns first 3 replies without root', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await fetchThreadSlice(asSlack(slack), 'C123', '1700000000.000000', 1, 3, 6);
    expect(result).toHaveLength(3);
    expect(result[0].ts).toBe('1700000001.000000'); // first reply
    expect(result[2].ts).toBe('1700000003.000000'); // third reply
  });

  it('offset=4, limit=10 returns remaining 2 messages (clamped)', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await fetchThreadSlice(asSlack(slack), 'C123', '1700000000.000000', 4, 10, 6);
    expect(result).toHaveLength(2); // only 2 left at offset 4 of 6 total
  });

  it('offset >= totalCount returns empty', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const result = await fetchThreadSlice(asSlack(slack), 'C123', '1700000000.000000', 6, 10, 6);
    expect(result).toHaveLength(0);
  });

  it('totalCount=0 returns empty', async () => {
    const slack = createMockSlack([]);
    const result = await fetchThreadSlice(asSlack(slack), 'C123', '1700000000.000000', 0, 10, 0);
    expect(result).toHaveLength(0);
  });

  it('handles multi-page pagination (thread > 200 messages)', async () => {
    const thread = makeThread(250);
    const slack = createMockSlack(thread, 200);
    // Fetch messages at offset 199 (last of page 1) and 200 (first of page 2)
    const result = await fetchThreadSlice(asSlack(slack), 'C123', '1700000000.000000', 199, 3, 251);
    expect(result).toHaveLength(3);
    expect(result[0].ts).toBe(`${1700000000 + 199}.000000`);
    expect(result[1].ts).toBe(`${1700000000 + 200}.000000`);
    expect(result[2].ts).toBe(`${1700000000 + 201}.000000`);
  });
});

// ── fetchMessagesBefore (legacy mode) tests ──────────────────────

describe('fetchMessagesBefore — legacy mode', () => {
  it('returns last N messages before anchor (root always included)', async () => {
    const thread = makeThread(10);
    const slack = createMockSlack(thread);
    const { messages } = await fetchMessagesBefore(asSlack(slack), 'C123', '1700000000.000000', '1700000005.000000', 3);
    // Root injected + 3 sliced = 4 (root was outside the window)
    expect(messages[0].ts).toBe('1700000000.000000'); // root always first
    expect(messages[1].ts).toBe('1700000003.000000');
    expect(messages[3].ts).toBe('1700000005.000000');
  });

  it('always includes root message with files', async () => {
    const thread = makeThread(5);
    thread[0].files = [{ id: 'F1', name: 'header.png' }];
    const slack = createMockSlack(thread);
    const { messages } = await fetchMessagesBefore(
      asSlack(slack),
      'C123',
      '1700000000.000000',
      '1700000005.000000',
      10,
    );
    expect(messages.some((m: any) => m.ts === '1700000000.000000')).toBe(true);
    expect(messages.find((m: any) => m.ts === '1700000000.000000')?.files[0].name).toBe('header.png');
  });

  it('reports rootWasInjected when root is outside count window', async () => {
    const thread = makeThread(10);
    const slack = createMockSlack(thread);
    const { rootWasInjected } = await fetchMessagesBefore(
      asSlack(slack),
      'C123',
      '1700000000.000000',
      '1700000005.000000',
      3,
    );
    expect(rootWasInjected).toBe(true);
  });

  it('rootWasInjected is false when root is within count window', async () => {
    const thread = makeThread(2);
    const slack = createMockSlack(thread);
    const { rootWasInjected } = await fetchMessagesBefore(
      asSlack(slack),
      'C123',
      '1700000000.000000',
      '1700000002.000000',
      10,
    );
    expect(rootWasInjected).toBe(false);
  });

  it('deep thread: root (with its files) survives .slice(-count)', async () => {
    const thread = makeThread(25);
    thread[0].files = [{ id: 'F1', name: 'header-image.png' }];
    const slack = createMockSlack(thread);
    const { messages, rootWasInjected } = await fetchMessagesBefore(
      asSlack(slack),
      'C123',
      '1700000000.000000',
      '1700000025.000000',
      20,
    );
    expect(messages[0].ts).toBe('1700000000.000000');
    expect(messages[0].files[0].name).toBe('header-image.png');
    expect(rootWasInjected).toBe(true);
    // 20 sliced + 1 injected root = 21
    expect(messages.length).toBe(21);
  });

  it('returns empty for count=0', async () => {
    const thread = makeThread(5);
    const slack = createMockSlack(thread);
    const { messages } = await fetchMessagesBefore(asSlack(slack), 'C123', '1700000000.000000', '1700000003.000000', 0);
    expect(messages).toHaveLength(0);
  });

  it('returns all available if count > available (no false rootWasInjected)', async () => {
    const thread = makeThread(3);
    const slack = createMockSlack(thread);
    const { messages, rootWasInjected } = await fetchMessagesBefore(
      asSlack(slack),
      'C123',
      '1700000000.000000',
      '1700000003.000000',
      50,
    );
    // root + 3 replies = 4 total, all fit in count=50
    expect(messages).toHaveLength(4);
    expect(rootWasInjected).toBe(false);
  });
});
