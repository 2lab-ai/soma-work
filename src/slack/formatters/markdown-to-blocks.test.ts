import { describe, it, expect } from 'vitest';
import { markdownToBlocks, thinkingToQuoteBlock } from './markdown-to-blocks';

describe('markdownToBlocks', () => {
  it('converts headers to header blocks', () => {
    const result = markdownToBlocks('# Title\n\nSome text');
    expect(result.blocks.length).toBeGreaterThan(0);

    const headerBlock = result.blocks.find(b => b.type === 'header');
    expect(headerBlock).toBeDefined();
    expect(headerBlock!.text.text).toBe('Title');
  });

  it('converts code blocks to rich_text with preformatted', () => {
    const result = markdownToBlocks('```typescript\nconst x = 1;\n```');
    expect(result.blocks.length).toBeGreaterThan(0);

    const richText = result.blocks.find(b => b.type === 'rich_text');
    expect(richText).toBeDefined();

    const preformatted = richText!.elements.find(
      (e: any) => e.type === 'rich_text_preformatted'
    );
    expect(preformatted).toBeDefined();
    expect(preformatted.elements[0].text).toContain('const x = 1;');
  });

  it('converts blockquotes to rich_text with quote', () => {
    const result = markdownToBlocks('> This is a quote');
    expect(result.blocks.length).toBeGreaterThan(0);

    const richText = result.blocks.find(b => b.type === 'rich_text');
    expect(richText).toBeDefined();

    const quote = richText!.elements.find(
      (e: any) => e.type === 'rich_text_quote'
    );
    expect(quote).toBeDefined();
    expect(quote.elements[0].text).toContain('This is a quote');
  });

  it('converts bullet lists to rich_text with list', () => {
    const result = markdownToBlocks('- item 1\n- item 2\n- item 3');
    expect(result.blocks.length).toBeGreaterThan(0);

    const richText = result.blocks.find(b => b.type === 'rich_text');
    expect(richText).toBeDefined();

    const list = richText!.elements.find(
      (e: any) => e.type === 'rich_text_list'
    );
    expect(list).toBeDefined();
    expect(list.style).toBe('bullet');
    expect(list.elements.length).toBe(3);
  });

  it('converts ordered lists to rich_text with ordered list', () => {
    const result = markdownToBlocks('1. first\n2. second\n3. third');
    expect(result.blocks.length).toBeGreaterThan(0);

    const richText = result.blocks.find(b => b.type === 'rich_text');
    expect(richText).toBeDefined();

    const list = richText!.elements.find(
      (e: any) => e.type === 'rich_text_list'
    );
    expect(list).toBeDefined();
    expect(list.style).toBe('ordered');
  });

  it('converts GFM tables to table blocks', () => {
    const md = '| Name | Value |\n|------|-------|\n| foo  | bar   |';
    const result = markdownToBlocks(md);

    const tableBlock = result.blocks.find(b => b.type === 'table');
    expect(tableBlock).toBeDefined();
    expect(tableBlock!.rows.length).toBe(2); // header + 1 data row
  });

  it('preserves inline formatting in lists', () => {
    const result = markdownToBlocks('- **bold** text\n- `code` text');
    const richText = result.blocks.find(b => b.type === 'rich_text');
    expect(richText).toBeDefined();

    const listItems = richText!.elements.find(
      (e: any) => e.type === 'rich_text_list'
    );
    expect(listItems).toBeDefined();

    // First item should have bold styling
    const firstItem = listItems.elements[0];
    const boldElement = firstItem.elements.find(
      (e: any) => e.style?.bold === true
    );
    expect(boldElement).toBeDefined();
  });

  it('provides fallback text on empty input', () => {
    const result = markdownToBlocks('');
    expect(result.fallbackText).toBe('');
    expect(result.blocks.length).toBe(0);
  });

  it('always provides fallback text', () => {
    const result = markdownToBlocks('# Hello\n\nWorld');
    expect(result.fallbackText).toBeTruthy();
    expect(typeof result.fallbackText).toBe('string');
  });

  it('handles complex Claude-like output', () => {
    const md = `# Analysis

## Findings

1. The **auth module** uses JWT
2. Rate limiting uses \`token-bucket\`

\`\`\`typescript
const x = 1;
\`\`\`

> Important note here

| Component | Status |
|-----------|--------|
| Auth      | Done   |
| Session   | WIP    |

- item with **bold**
- item with [link](https://example.com)`;

    const result = markdownToBlocks(md);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.length).toBeLessThanOrEqual(45);

    // Should have headers, rich_text, and table
    const types = result.blocks.map(b => b.type);
    expect(types).toContain('header');
    expect(types).toContain('rich_text');
    expect(types).toContain('table');
  });
});

describe('markdownToBlocks overflow', () => {
  it('splits messages when blocks exceed limit', () => {
    // Generate markdown with many sections to exceed 45 blocks
    const sections = Array.from({ length: 50 }, (_, i) =>
      `## Section ${i}\n\nParagraph ${i}`
    ).join('\n\n');

    const result = markdownToBlocks(sections);
    // Primary + overflow should contain all blocks
    const totalBlocks = result.blocks.length +
      result.overflow.reduce((sum, msg) => sum + msg.length, 0);
    expect(totalBlocks).toBeGreaterThan(45);
    expect(result.blocks.length).toBeLessThanOrEqual(45);
  });

  it('separates multiple tables into different messages', () => {
    const md = `| A | B |\n|---|---|\n| 1 | 2 |\n\nSome text\n\n| C | D |\n|---|---|\n| 3 | 4 |`;
    const result = markdownToBlocks(md);

    const primaryTables = result.blocks.filter(b => b.type === 'table');
    expect(primaryTables.length).toBeLessThanOrEqual(1);

    if (result.overflow.length > 0) {
      // Second table should be in overflow
      const overflowTables = result.overflow.flatMap(
        msg => msg.filter(b => b.type === 'table')
      );
      expect(overflowTables.length).toBeGreaterThan(0);
    }
  });
});

describe('markdownToBlocks table sanitization', () => {
  it('truncates tables with too many rows', () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      `| row${i} | val${i} |`
    ).join('\n');
    const md = `| Name | Value |\n|------|-------|\n${rows}`;

    const result = markdownToBlocks(md);
    const tableBlock = result.blocks.find(b => b.type === 'table');
    if (tableBlock) {
      expect(tableBlock.rows.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('markdownToBlocks header sanitization', () => {
  it('truncates headers exceeding 150 chars', () => {
    const longTitle = 'A'.repeat(200);
    const result = markdownToBlocks(`# ${longTitle}`);

    const headerBlock = result.blocks.find(b => b.type === 'header');
    expect(headerBlock).toBeDefined();
    expect(headerBlock!.text.text.length).toBeLessThanOrEqual(150);
    expect(headerBlock!.text.text).toContain('...');
  });

  it('preserves headers within 150 chars', () => {
    const result = markdownToBlocks('# Short Title');
    const headerBlock = result.blocks.find(b => b.type === 'header');
    expect(headerBlock).toBeDefined();
    expect(headerBlock!.text.text).toBe('Short Title');
  });
});

describe('markdownToBlocks error handling', () => {
  it('returns empty blocks with fallback on invalid input', () => {
    // null/undefined-like edge cases
    const result = markdownToBlocks('');
    expect(result.blocks).toEqual([]);
    expect(result.overflow).toEqual([]);
  });

  it('always provides usable fallback text', () => {
    const md = '# Hello\n\n**World** with `code`';
    const result = markdownToBlocks(md);
    expect(result.fallbackText).toBeTruthy();
    // Fallback should convert ** to * for Slack mrkdwn
    expect(result.fallbackText).toContain('*World*');
  });
});

describe('thinkingToQuoteBlock', () => {
  it('wraps thinking text in rich_text_quote', () => {
    const block = thinkingToQuoteBlock('I am thinking about this');

    expect(block.type).toBe('rich_text');
    expect(block.elements).toHaveLength(1);
    expect(block.elements[0].type).toBe('rich_text_quote');
  });

  it('includes thought balloon emoji', () => {
    const block = thinkingToQuoteBlock('Thinking...');

    const elements = block.elements[0].elements;
    const emoji = elements.find((e: any) => e.type === 'emoji');
    expect(emoji).toBeDefined();
    expect(emoji.name).toBe('thought_balloon');
  });

  it('applies italic style to thinking text', () => {
    const block = thinkingToQuoteBlock('My analysis');

    const elements = block.elements[0].elements;
    const textEl = elements.find((e: any) => e.type === 'text');
    expect(textEl).toBeDefined();
    expect(textEl.style.italic).toBe(true);
    expect(textEl.text).toContain('My analysis');
  });
});
