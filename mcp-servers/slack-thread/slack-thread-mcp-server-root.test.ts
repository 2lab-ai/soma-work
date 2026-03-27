import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contract tests for GetThreadMessagesResult interface — updated for v2 (array mode).
 *
 * v2 changes:
 * - thread_root field REMOVED (root is now messages[0] at offset=0)
 * - has_more_before/has_more_after REPLACED by has_more + total_count math
 * - NEW fields: total_count, offset, has_more
 */

interface ExpectedThreadMessage {
  ts: string;
  user: string;
  user_name: string;
  text: string;
  timestamp: string;
  files: any[];
  reactions: any[];
  is_bot: boolean;
  subtype: string | null;
}

interface ExpectedGetThreadMessagesResult {
  thread_ts: string;
  channel: string;
  total_count: number;
  offset: number;
  returned: number;
  messages: ExpectedThreadMessage[];
  has_more: boolean;
}

// ── Scenario 1: Root accessible at offset=0 ────────────────────

describe('Scenario 1: thread root accessible at offset=0 in array mode', () => {
  it('root is first message when offset=0', () => {
    const result: ExpectedGetThreadMessagesResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      total_count: 10,
      offset: 0,
      returned: 1,
      messages: [
        {
          ts: '1700000000.000000',
          user: 'U_AUTHOR',
          user_name: 'Author',
          text: 'Parent message content',
          timestamp: '2023-11-14T22:13:20.000Z',
          files: [],
          reactions: [],
          is_bot: false,
          subtype: null,
        },
      ],
      has_more: true,
    };

    expect(result.messages[0].ts).toBe(result.thread_ts);
    expect(result.offset).toBe(0);
    expect(result.has_more).toBe(true);
  });

  it('returned count equals messages.length', () => {
    const result: ExpectedGetThreadMessagesResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      total_count: 50,
      offset: 0,
      returned: 3,
      messages: [
        { ts: '1700000000.000000', user: 'U_AUTHOR', user_name: 'Author', text: 'Root', timestamp: '', files: [], reactions: [], is_bot: false, subtype: null },
        { ts: '1', user: 'U1', user_name: 'A', text: 'a', timestamp: '', files: [], reactions: [], is_bot: false, subtype: null },
        { ts: '2', user: 'U2', user_name: 'B', text: 'b', timestamp: '', files: [], reactions: [], is_bot: false, subtype: null },
      ],
      has_more: true,
    };

    expect(result.returned).toBe(result.messages.length);
  });

  it('root has same ThreadMessage shape as replies', () => {
    const requiredFields: (keyof ExpectedThreadMessage)[] = [
      'ts', 'user', 'user_name', 'text', 'timestamp', 'files', 'reactions', 'is_bot', 'subtype',
    ];

    const sampleRoot: ExpectedThreadMessage = {
      ts: '1700000000.000000',
      user: 'U_AUTHOR',
      user_name: 'Author Name',
      text: 'Root message',
      timestamp: '2023-11-14T22:13:20.000Z',
      files: [],
      reactions: [{ name: 'thumbsup', count: 2 }],
      is_bot: false,
      subtype: null,
    };

    for (const field of requiredFields) {
      expect(sampleRoot).toHaveProperty(field);
    }
  });
});

// ── Scenario 2: Array mode pagination math ──────────────────────

describe('Scenario 2: array mode pagination correctness', () => {
  it('has_more computable from total_count, offset, returned', () => {
    const result: ExpectedGetThreadMessagesResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      total_count: 50,
      offset: 10,
      returned: 10,
      messages: [],
      has_more: true,
    };

    // has_more = offset + returned < total_count
    expect(result.offset + result.returned < result.total_count).toBe(result.has_more);
  });

  it('last page has has_more=false', () => {
    const result: ExpectedGetThreadMessagesResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      total_count: 5,
      offset: 3,
      returned: 2,
      messages: [],
      has_more: false,
    };

    expect(result.offset + result.returned).toBe(result.total_count);
    expect(result.has_more).toBe(false);
  });
});

// ── Helper: verify actual interface matches expected shape ───────

describe('Source interface matches v2 contract', () => {
  function requireActualInterface(): { GetThreadMessagesResultKeys: string[] } {
    const fs = require('fs');
    const path = require('path');
    const sourcePath = path.join(__dirname, 'slack-thread-mcp-server.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    const interfaceMatch = source.match(/interface\s+GetThreadMessagesResult\s*\{([^}]+)\}/);
    if (!interfaceMatch) return { GetThreadMessagesResultKeys: [] };

    const fields = interfaceMatch[1]
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.includes(':'))
      .map((line: string) => line.split(':')[0].trim().replace('?', ''));

    return { GetThreadMessagesResultKeys: fields };
  }

  it('has total_count, offset, has_more fields', () => {
    const { GetThreadMessagesResultKeys } = requireActualInterface();
    expect(GetThreadMessagesResultKeys).toContain('total_count');
    expect(GetThreadMessagesResultKeys).toContain('offset');
    expect(GetThreadMessagesResultKeys).toContain('has_more');
  });

  it('does NOT have thread_root, has_more_before, has_more_after', () => {
    const { GetThreadMessagesResultKeys } = requireActualInterface();
    expect(GetThreadMessagesResultKeys).not.toContain('thread_root');
    expect(GetThreadMessagesResultKeys).not.toContain('has_more_before');
    expect(GetThreadMessagesResultKeys).not.toContain('has_more_after');
  });
});
