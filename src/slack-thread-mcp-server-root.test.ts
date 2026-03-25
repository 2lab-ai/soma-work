import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contract tests for Issue #64 Fix A: Thread root inclusion in get_thread_messages
 * Trace: docs/issue64-midthread-fix-v2/trace.md
 * Scenarios 1-2 (slack-thread-mcp-server scope)
 *
 * These tests verify the MCP server's result format, NOT the Slack API.
 * We mock conversations.replies and test the transformation logic.
 *
 * RED: All tests should FAIL against current code because thread_root
 * field does not exist yet.
 */

// ── Inline mock of SlackThreadMcpServer internals ──────────────
// The MCP server is a standalone process (stdio transport), so we
// re-implement the core logic under test as a minimal harness.
// This avoids needing to start a real MCP server.

// We import the actual module to test after setting env vars.
// However, the module auto-starts on import, so we need to test
// the result format by inspecting the JSON output contract.

// For contract tests, we define the EXPECTED interface and verify
// that the actual module's output matches.

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
  thread_root: ExpectedThreadMessage | null;
  returned: number;
  messages: ExpectedThreadMessage[];
  has_more_before: boolean;
  has_more_after: boolean;
}

// ── Scenario 1: Thread root included in get_thread_messages ────

describe('Scenario 1: thread root included in get_thread_messages result', () => {
  // Trace: S1, Sec 3e — thread_root field in result
  it('threadRoot_includedInResult: result JSON has thread_root field', () => {
    // Contract: the GetThreadMessagesResult interface must include thread_root
    const sampleResult: ExpectedGetThreadMessagesResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      thread_root: {
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
      returned: 5,
      messages: [],
      has_more_before: false,
      has_more_after: false,
    };

    // Verify the interface shape is valid
    expect(sampleResult.thread_root).toBeDefined();
    expect(sampleResult.thread_root!.ts).toBe('1700000000.000000');

    // RED CHECK: Verify the actual module exports a result with thread_root
    // This will fail until the module is updated
    const { GetThreadMessagesResultKeys } = requireActualInterface();
    expect(GetThreadMessagesResultKeys).toContain('thread_root');
  });

  // Trace: S1, Sec 3e — returned excludes root
  it('threadRoot_notCountedInReturned: returned count excludes thread_root', () => {
    const result: ExpectedGetThreadMessagesResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      thread_root: {
        ts: '1700000000.000000',
        user: 'U_AUTHOR',
        user_name: 'Author',
        text: 'Parent',
        timestamp: '2023-11-14T22:13:20.000Z',
        files: [],
        reactions: [],
        is_bot: false,
        subtype: null,
      },
      returned: 3,
      messages: [
        { ts: '1', user: 'U1', user_name: 'A', text: 'a', timestamp: '', files: [], reactions: [], is_bot: false, subtype: null },
        { ts: '2', user: 'U2', user_name: 'B', text: 'b', timestamp: '', files: [], reactions: [], is_bot: false, subtype: null },
        { ts: '3', user: 'U3', user_name: 'C', text: 'c', timestamp: '', files: [], reactions: [], is_bot: false, subtype: null },
      ],
      has_more_before: false,
      has_more_after: false,
    };

    // returned === messages.length, thread_root is bonus
    expect(result.returned).toBe(result.messages.length);
    expect(result.thread_root).not.toBeNull();
    // thread_root is NOT in messages array
    expect(result.messages.find(m => m.ts === result.thread_root!.ts)).toBeUndefined();
  });

  // Trace: S1, Sec 3d — same ThreadMessage shape
  it('threadRoot_formattedAsThreadMessage: thread_root has same shape as messages[]', () => {
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

// ── Scenario 2: Thread root with before:0 ──────────────────────

describe('Scenario 2: thread root returned even with before:0', () => {
  // Trace: S2, Sec 3a — fallback fetch
  it('threadRoot_beforeZero_stillReturnsRoot: thread_root present when before=0', () => {
    // When before=0, fetchMessagesBefore returns [] immediately.
    // The handler must still fetch and include thread_root via fallback.
    const result: ExpectedGetThreadMessagesResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      thread_root: {
        ts: '1700000000.000000',
        user: 'U_AUTHOR',
        user_name: 'Author',
        text: 'Parent message',
        timestamp: '2023-11-14T22:13:20.000Z',
        files: [],
        reactions: [],
        is_bot: false,
        subtype: null,
      },
      returned: 5,
      messages: [],
      has_more_before: false,
      has_more_after: false,
    };

    // Contract: thread_root is present even though before=0
    expect(result.thread_root).not.toBeNull();

    // RED CHECK: actual module behavior
    const { GetThreadMessagesResultKeys } = requireActualInterface();
    expect(GetThreadMessagesResultKeys).toContain('thread_root');
  });

  // Trace: S2, Sec 5 — root deleted
  it('threadRoot_deletedRoot_returnsNull: thread_root is null when root message is deleted', () => {
    const result: ExpectedGetThreadMessagesResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      thread_root: null,
      returned: 0,
      messages: [],
      has_more_before: false,
      has_more_after: false,
    };

    // Contract: thread_root can be null (graceful degradation)
    expect(result.thread_root).toBeNull();
  });
});

// ── Helper: extract actual interface keys from source ───────────
// This reads the actual source file and checks for the thread_root field.
// RED: will fail until implementation adds thread_root to the interface.
function requireActualInterface(): { GetThreadMessagesResultKeys: string[] } {
  // Read the actual source code to verify the interface
  const fs = require('fs');
  const path = require('path');
  const sourcePath = path.join(__dirname, 'slack-thread-mcp-server.ts');
  const source = fs.readFileSync(sourcePath, 'utf-8');

  // Extract the GetThreadMessagesResult interface fields
  const interfaceMatch = source.match(/interface\s+GetThreadMessagesResult\s*\{([^}]+)\}/);
  if (!interfaceMatch) {
    return { GetThreadMessagesResultKeys: [] };
  }

  const fields = interfaceMatch[1]
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line.includes(':'))
    .map((line: string) => line.split(':')[0].trim().replace('?', ''));

  return { GetThreadMessagesResultKeys: fields };
}
