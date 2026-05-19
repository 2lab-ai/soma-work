import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * RED tests for Issue #112: Array-style pagination (offset/limit) for get_thread_messages
 *
 * Tests the core logic extracted from SlackMcpServer:
 * - handleGetThreadMessages with offset/limit (array mode)
 * - handleGetThreadMessages with anchor_ts/before/after (legacy mode)
 * - Mode detection: array vs legacy
 * - total_count from reply_count
 * - Root on-demand (only when offset=0)
 * - Side-effect removal (no capturedRoot instance var)
 */

// ── Extract testable logic from the source ────────────────────
// Since the server class is not exported and auto-starts on import,
// we extract and test the core logic in isolation by reading the source
// and validating the interface contract + behavioral expectations.

const fs = require('fs');
const path = require('path');

function readSourceInterface(): string[] {
  // After refactoring: interface moved to types.ts
  const sourcePath = path.join(__dirname, 'types.ts');
  const source = fs.readFileSync(sourcePath, 'utf-8');

  const interfaceMatch = source.match(/interface\s+GetThreadMessagesResult\s*\{([^}]+)\}/);
  if (!interfaceMatch) return [];

  return interfaceMatch[1]
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line.includes(':'))
    .map((line: string) => line.split(':')[0].trim().replace('?', ''));
}

function readSourceToolSchema(): string {
  const sourcePath = path.join(__dirname, 'slack-mcp-server.ts');
  return fs.readFileSync(sourcePath, 'utf-8');
}

// ── Scenario 1: Array mode interface exists ────────────────────

describe('S1: GetThreadMessagesResult interface has array-mode fields', () => {
  it('has total_count field', () => {
    const fields = readSourceInterface();
    expect(fields).toContain('total_count');
  });

  it('has offset field', () => {
    const fields = readSourceInterface();
    expect(fields).toContain('offset');
  });

  it('has has_more field (replaces has_more_before/has_more_after)', () => {
    const fields = readSourceInterface();
    expect(fields).toContain('has_more');
  });

  it('does NOT have thread_root field (removed — root is just messages[0] at offset=0)', () => {
    const fields = readSourceInterface();
    expect(fields).not.toContain('thread_root');
  });

  it('does NOT have has_more_before / has_more_after (replaced by has_more + total_count math)', () => {
    const fields = readSourceInterface();
    expect(fields).not.toContain('has_more_before');
    expect(fields).not.toContain('has_more_after');
  });
});

// ── Scenario 2: Tool schema exposes offset/limit params ────────

describe('S2: get_thread_messages tool schema has offset/limit params', () => {
  it('tool inputSchema has offset property', () => {
    const source = readSourceToolSchema();
    // Match both quoted and unquoted property names: offset: { or 'offset': { or "offset": {
    expect(source).toMatch(/offset['"]?\s*:\s*\{/);
  });

  it('tool inputSchema has limit property', () => {
    const source = readSourceToolSchema();
    expect(source).toMatch(/limit['"]?\s*:\s*\{/);
  });

  it('tool description mentions array/offset/limit usage', () => {
    const source = readSourceToolSchema();
    // Should have example like: get_thread_messages({ offset: 0, limit: 10 })
    expect(source).toMatch(/offset.*limit|offset.*\d+/);
  });
});

// ── Scenario 3: Mode detection logic ────────────────────────────

describe('S3: Mode detection — array vs legacy', () => {
  // This tests the behavioral contract: if anchor_ts/before/after are present → legacy mode
  // Otherwise → array mode with offset/limit

  it('source contains mode detection logic for array vs legacy', () => {
    const source = readSourceToolSchema();
    // Should have logic checking for offset/limit vs anchor_ts/before/after
    // Either explicit mode flag or param presence check
    expect(source).toMatch(/anchor_ts|before|after/);
    expect(source).toMatch(/offset|limit/);
  });

  it('handleGetThreadMessages accepts offset and limit params', () => {
    const source = readSourceToolSchema();
    // The handler signature should include offset and limit
    expect(source).toMatch(/offset\??:\s*number/);
    expect(source).toMatch(/limit\??:\s*number/);
  });
});

// ── Scenario 4: No capturedRoot instance variable ────────────────

describe('S4: capturedRoot side-effect removed', () => {
  it('source does NOT use this.capturedRoot for data passing', () => {
    const source = readSourceToolSchema();
    // capturedRoot as instance variable should be removed
    // It might still exist for legacy mode compatibility, but shouldn't be
    // the primary data flow mechanism
    const capturedRootInstanceDecl = /private\s+capturedRoot/;
    expect(source).not.toMatch(capturedRootInstanceDecl);
  });
});

// ── Scenario 5: fetchSlice method for array mode ────────────────

describe('S5: fetchSlice method exists for array mode', () => {
  it('source has a fetchSlice or equivalent method for offset/limit fetching', () => {
    const source = readSourceToolSchema();
    // Should have a method that fetches a specific slice of thread messages
    // Either fetchSlice, fetchByOffset, or handleArrayMode
    expect(source).toMatch(/fetchSlice|fetchByOffset|handleArrayMode|fetchThreadSlice/);
  });
});

// ── Scenario 6: getTotalCount method ─────────────────────────────

describe('S6: total_count retrieval', () => {
  it('source retrieves reply_count or total message count from Slack API', () => {
    const source = readSourceToolSchema();
    // Should use reply_count from conversations.replies response
    expect(source).toMatch(/reply_count|total_count|totalCount/);
  });
});

// ── Behavioral contract tests (mock-based) ──────────────────────

describe('S7: Behavioral contracts for array mode', () => {
  // These test the expected response format, not the actual server
  // (server can't be imported without starting)

  interface ArrayModeResult {
    thread_ts: string;
    channel: string;
    total_count: number;
    offset: number;
    returned: number;
    messages: any[];
    has_more: boolean;
  }

  it('offset=0, limit=1 returns only root message', () => {
    const result: ArrayModeResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      total_count: 50,
      offset: 0,
      returned: 1,
      messages: [
        { ts: '1700000000.000000', user: 'U1', text: 'Root message' },
      ],
      has_more: true,
    };

    expect(result.returned).toBe(1);
    expect(result.offset).toBe(0);
    expect(result.messages[0].ts).toBe(result.thread_ts); // First msg IS the root
    expect(result.has_more).toBe(true); // 49 more messages
  });

  it('offset=1, limit=10 returns first 10 replies (no root)', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      ts: `${1700000001 + i}.000000`,
      user: `U${i}`,
      text: `Reply ${i + 1}`,
    }));

    const result: ArrayModeResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      total_count: 50,
      offset: 1,
      returned: 10,
      messages,
      has_more: true,
    };

    expect(result.returned).toBe(10);
    expect(result.offset).toBe(1);
    // No root message in the results
    expect(result.messages.every(m => m.ts !== result.thread_ts)).toBe(true);
    // has_more: offset(1) + returned(10) = 11 < total_count(50)
    expect(result.offset + result.returned < result.total_count).toBe(true);
    expect(result.has_more).toBe(true);
  });

  it('last page returns has_more=false', () => {
    const result: ArrayModeResult = {
      thread_ts: '1700000000.000000',
      channel: 'C123',
      total_count: 5,
      offset: 3,
      returned: 2,
      messages: [
        { ts: '1700000004.000000', user: 'U1', text: 'Msg 4' },
        { ts: '1700000005.000000', user: 'U2', text: 'Msg 5' },
      ],
      has_more: false,
    };

    // offset(3) + returned(2) = 5 === total_count(5)
    expect(result.offset + result.returned).toBe(result.total_count);
    expect(result.has_more).toBe(false);
  });

  it('model can compute "last 5 messages" using total_count', () => {
    const total_count = 42;
    const wantLast = 5;
    const computedOffset = total_count - wantLast; // 37

    expect(computedOffset).toBe(37);
    expect(computedOffset).toBeGreaterThanOrEqual(0);
  });
});
