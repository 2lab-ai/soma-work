import { describe, it, expect } from 'vitest';
import { ThreadHeaderBuilder } from './thread-header-builder';

function collectBlockTexts(blocks: any[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (typeof block?.text?.text === 'string') {
      lines.push(block.text.text);
    }
    if (Array.isArray(block?.elements)) {
      for (const element of block.elements) {
        if (typeof element?.text === 'string') {
          lines.push(element.text);
        }
      }
    }
  }
  return lines;
}

describe('ThreadHeaderBuilder', () => {
  it('renders header block + context metadata (title/workflow/owner)', () => {
    const payload = ThreadHeaderBuilder.build({
      title: 'Prada /test-vsprots 페이지 개발',
      workflow: 'default',
      ownerName: 'Bash',
    });

    const blocks = (payload.blocks || []) as any[];
    const lines = collectBlockTexts(blocks).join(' ');

    // Header block with title + owner (prominently visible)
    const headerBlock = blocks.find((b) => b.type === 'header');
    expect(headerBlock).toBeDefined();
    expect(headerBlock.text.text).toBe('Prada /test-vsprots 페이지 개발 — Bash');

    // Context with workflow (owner is now in header, not context)
    expect(lines).toContain('`default`');
    expect(lines).not.toContain('*Bash*');
    expect(lines).not.toContain('👤');
    expect(lines).not.toContain('작업 중');
    expect(lines).not.toContain('🧠');
    expect(lines).not.toContain('🤖');
    expect(lines).not.toContain('🕐');
    expect(lines).not.toContain('⏳');
  });

  it('does not render Slack message links in thread header link context', () => {
    const payload = ThreadHeaderBuilder.build({
      title: 'Header',
      links: {
        issue: {
          url: 'https://workspace.slack.com/archives/C123/p1739000000001000',
          type: 'issue',
          provider: 'unknown',
          label: 'Slack link',
        },
        pr: {
          url: 'https://github.com/org/repo/pull/10',
          type: 'pr',
          provider: 'github',
          label: 'PR #10',
        },
      },
    });

    const blocks = (payload.blocks || payload.attachments?.[0]?.blocks || []) as any[];
    const linkContext = blocks.find((block) =>
      block.type === 'context'
      && Array.isArray(block.elements)
      && block.elements.some((el: any) => String(el.text || '').includes('github.com'))
    );

    expect(linkContext).toBeDefined();
    const linkTexts = linkContext.elements.map((el: any) => String(el.text));
    expect(linkTexts.join(' ')).toContain('github.com');
    expect(linkTexts.join(' ')).not.toContain('slack.com/archives');
  });

  it('builds thread header as top-level blocks to avoid duplicate attachment rendering', () => {
    const payload = ThreadHeaderBuilder.build({
      title: 'Header',
      workflow: 'default',
      ownerName: 'Tester',
      links: {
        pr: {
          url: 'https://github.com/org/repo/pull/10',
          type: 'pr',
          provider: 'github',
          label: 'PR #10',
        },
      },
    });

    expect(Array.isArray(payload.blocks)).toBe(true);
    expect((payload.blocks || []).length).toBeGreaterThan(0);
    expect(payload.attachments).toBeUndefined();
  });
});
