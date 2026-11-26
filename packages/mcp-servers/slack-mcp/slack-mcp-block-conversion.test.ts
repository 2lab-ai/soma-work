import { markdownToBlocks as libMarkdownToBlocks } from 'markdown-to-slack-blocks';
import { describe, expect, it } from 'vitest';

/**
 * The markdown-to-slack-blocks library send_thread_message converts with: what it gives back for the
 * markdown shapes the server relies on (native tables, headers, mrkdwn sections, nothing for blank input).
 *
 * The server's own handling of those blocks — row and header caps, one table per message, the mrkdwn
 * fallback and the retry when Slack refuses the blocks — is driven through its MCP handlers in
 * slack-mcp-contract.test.ts.
 */

// ── Library integration: table rendering ─────────────────────

describe('markdown-to-slack-blocks library: table rendering', () => {
  it('converts GFM table to native table block', () => {
    const md = '| Name | Value |\n|------|-------|\n| foo  | bar   |';
    const blocks = libMarkdownToBlocks(md) as any[];
    expect(blocks.length).toBeGreaterThan(0);
    const tableBlock = blocks.find((b: any) => b.type === 'table');
    expect(tableBlock).toBeDefined();
    expect(tableBlock.rows).toBeDefined();
    expect(tableBlock.rows.length).toBe(2); // header + 1 data row
  });

  it('produces section/mrkdwn blocks for simple paragraphs', () => {
    const md = 'Hello **world** and *italic*';
    const blocks = libMarkdownToBlocks(md) as any[];
    expect(blocks.length).toBeGreaterThan(0);
    // Library converts inline formatting to section+mrkdwn
    const section = blocks.find((b: any) => b.type === 'section');
    expect(section).toBeDefined();
    expect(section.text.type).toBe('mrkdwn');
  });

  it('produces header blocks for headings', () => {
    const md = '# My Heading\n\nSome text';
    const blocks = libMarkdownToBlocks(md) as any[];
    const header = blocks.find((b: any) => b.type === 'header');
    expect(header).toBeDefined();
    expect(header.text.text).toBe('My Heading');
  });

  it('returns empty array for empty input', () => {
    expect(libMarkdownToBlocks('')).toEqual([]);
    expect(libMarkdownToBlocks('   ')).toEqual([]);
    expect(libMarkdownToBlocks('\n\n')).toEqual([]);
  });
});
