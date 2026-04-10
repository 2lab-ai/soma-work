import { describe, it, expect } from 'vitest';
import { markdownToBlocks as libMarkdownToBlocks } from 'markdown-to-slack-blocks';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Tests for send_thread_message Block Kit conversion pipeline.
 *
 * Validates that handleSendThreadMessage uses markdown-to-slack-blocks library
 * to produce native table/header/rich_text blocks, with proper sanitization,
 * message splitting (1 table per message, 45-block cap), and fallback handling.
 *
 * Since SlackMcpServer is not exported, we:
 * 1. Verify source-code structure (grep-based)
 * 2. Test the library integration directly
 * 3. Re-implement convertMarkdownToBlocks logic for behavioral testing
 */

const serverPath = path.resolve(__dirname, 'slack-mcp-server.ts');

// ── Re-implement convertMarkdownToBlocks for testing ─────────

function convertMarkdownToBlocks(markdown: string) {
  const MAX_BLOCKS = 45;
  const MAX_TABLE_ROWS = 100;
  const MAX_TABLE_COLS = 20;
  const MAX_HEADER_LEN = 150;
  const fallbackText = markdown; // simplified for tests

  const rawBlocks = libMarkdownToBlocks(markdown) as Array<Record<string, unknown>>;
  if (!rawBlocks || rawBlocks.length === 0) {
    return { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: fallbackText } }], fallbackText, overflow: [] };
  }

  const sanitized = rawBlocks.map((block) => {
    if (block.type === 'table') {
      const rows = block.rows as any[][];
      if (!rows || rows.length === 0) return block;
      const truncRows = rows.slice(0, MAX_TABLE_ROWS).map((r: any[]) => r.slice(0, MAX_TABLE_COLS));
      return { ...block, rows: truncRows };
    }
    if (block.type === 'header') {
      const text = (block.text as any)?.text || '';
      if (text.length > MAX_HEADER_LEN) {
        return { ...block, text: { ...(block.text as any), text: text.slice(0, MAX_HEADER_LEN - 3) + '...' } };
      }
    }
    return block;
  });

  const tableCount = sanitized.filter((b) => b.type === 'table').length;
  if (sanitized.length <= MAX_BLOCKS && tableCount <= 1) {
    return { blocks: sanitized, fallbackText, overflow: [] };
  }

  const messages: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let curTables = 0;

  for (const block of sanitized) {
    const isTable = block.type === 'table';
    if ((current.length >= MAX_BLOCKS) || (isTable && curTables >= 1)) {
      if (current.length > 0) messages.push(current);
      current = [];
      curTables = 0;
    }
    current.push(block);
    if (isTable) curTables++;
  }
  if (current.length > 0) messages.push(current);

  const [primary, ...overflow] = messages;
  return { blocks: primary || [], fallbackText, overflow };
}

// ── Source structure tests ───────────────────────────────────

describe('send_thread_message Block Kit conversion: source structure', () => {
  it('imports markdown-to-slack-blocks library', async () => {
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain("from 'markdown-to-slack-blocks'");
  });

  it('handleSendThreadMessage calls convertMarkdownToBlocks', async () => {
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toContain('convertMarkdownToBlocks');
    expect(source).toMatch(/handleSendThreadMessage[\s\S]*?convertMarkdownToBlocks/);
  });

  it('has mrkdwn fallback when Block Kit conversion fails', async () => {
    const source = await fs.readFile(serverPath, 'utf-8');
    // catch block falls back to formatToMrkdwn
    expect(source).toMatch(/convertMarkdownToBlocks[\s\S]*?catch[\s\S]*?formatToMrkdwn/);
  });

  it('has Slack block-rejection retry with mrkdwn fallback', async () => {
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toMatch(/invalid_blocks|invalid_attachments/);
    expect(source).toMatch(/Slack rejected blocks.*retrying/);
  });

  it('handles overflow messages for multi-table content', async () => {
    const source = await fs.readFile(serverPath, 'utf-8');
    expect(source).toMatch(/overflow/i);
    // Overflow sends additional postMessage calls
    expect(source).toMatch(/overflowBlocks[\s\S]*?chat\.postMessage/);
  });
});

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

// ── convertMarkdownToBlocks behavioral tests ─────────────────

describe('convertMarkdownToBlocks logic', () => {
  it('produces native table block for table markdown', () => {
    const md = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |';
    const result = convertMarkdownToBlocks(md);
    const tableBlock = result.blocks.find((b) => b.type === 'table');
    expect(tableBlock).toBeDefined();
    expect(result.overflow).toEqual([]);
  });

  it('falls back to mrkdwn section when input produces no blocks', () => {
    const result = convertMarkdownToBlocks('');
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe('section');
  });

  it('splits multiple tables into separate messages (1 table per message)', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n\nText\n\n| C | D |\n|---|---|\n| 3 | 4 |';
    const result = convertMarkdownToBlocks(md);

    // Primary should have at most 1 table
    const primaryTables = result.blocks.filter((b) => b.type === 'table');
    expect(primaryTables.length).toBeLessThanOrEqual(1);

    // Overflow should contain the second table
    expect(result.overflow.length).toBeGreaterThan(0);
    const overflowTables = result.overflow.flat().filter((b) => b.type === 'table');
    expect(overflowTables.length).toBeGreaterThan(0);
  });

  it('truncates table rows exceeding MAX_TABLE_ROWS', () => {
    // Build a table with 110 rows (header + 109 data)
    const header = '| A | B |';
    const sep = '|---|---|';
    const rows = Array.from({ length: 109 }, (_, i) => `| ${i} | val |`);
    const md = [header, sep, ...rows].join('\n');

    const result = convertMarkdownToBlocks(md);
    const tableBlock = result.blocks.find((b) => b.type === 'table') as any;
    expect(tableBlock).toBeDefined();
    // 100 = MAX_TABLE_ROWS (header row + 99 data, or first 100 total)
    expect(tableBlock.rows.length).toBeLessThanOrEqual(100);
  });

  it('truncates header text exceeding 150 chars', () => {
    const longTitle = 'A'.repeat(200);
    const md = `# ${longTitle}\n\nSome text`;
    const result = convertMarkdownToBlocks(md);
    const header = result.blocks.find((b) => b.type === 'header') as any;
    expect(header).toBeDefined();
    expect(header.text.text.length).toBeLessThanOrEqual(150);
    expect(header.text.text).toContain('...');
  });

  it('handles mixed content: heading + table + paragraph', () => {
    const md = '# Summary\n\n| Key | Value |\n|-----|-------|\n| a   | 1     |\n\nDone.';
    const result = convertMarkdownToBlocks(md);
    const types = result.blocks.map((b) => b.type);
    expect(types).toContain('header');
    expect(types).toContain('table');
  });
});
