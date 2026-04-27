import { describe, expect, it } from 'vitest';
import type { SessionUsage } from '../../types';
import { ThreadHeaderBuilder } from '../thread-header-builder';

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
      theme: 'default',
    });

    const blocks = (payload.blocks || []) as any[];
    const lines = collectBlockTexts(blocks).join(' ');

    // Header block with title (Default theme shows title only in header, owner in context)
    const headerBlock = blocks.find((b) => b.type === 'header');
    expect(headerBlock).toBeDefined();
    expect(headerBlock.text.text).toBe('Prada /test-vsprots 페이지 개발');

    // Context with workflow (owner mention not testable without ownerId)
    expect(lines).toContain('`default`');
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
      theme: 'default',
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
    const linkContext = blocks.find(
      (block) =>
        block.type === 'context' &&
        Array.isArray(block.elements) &&
        block.elements.some((el: any) => String(el.text || '').includes('github.com')),
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

  it('includes model chip and context bar when usage data is provided', () => {
    const usage: SessionUsage = {
      currentInputTokens: 100_000,
      currentOutputTokens: 50_000,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      contextWindow: 1_000_000,
      totalInputTokens: 200_000,
      totalOutputTokens: 80_000,
      totalCacheReadTokens: 0,
      totalCacheCreateTokens: 0,
      totalCostUsd: 0.5,
      lastUpdated: Date.now(),
    };

    const payload = ThreadHeaderBuilder.build({
      title: 'Context Test',
      workflow: 'default',
      ownerName: 'Tester',
      model: 'claude-opus-4-6-20250414',
      usage,
    });

    const blocks = (payload.blocks || []) as any[];
    const lines = collectBlockTexts(blocks).join(' ');

    // Model chip
    expect(lines).toContain('`opus-4.6`');
    // Context bar (150k used of 1M = 15% used → 1 filled segment of 5)
    expect(lines).toContain('150k/1M');
  });

  it('does not show model/context when not provided', () => {
    const payload = ThreadHeaderBuilder.build({
      title: 'No Model',
      workflow: 'default',
    });

    const blocks = (payload.blocks || []) as any[];
    const lines = collectBlockTexts(blocks).join(' ');

    expect(lines).not.toContain('▓');
    expect(lines).not.toContain('░');
  });
});

describe('ThreadHeaderBuilder.formatModelName', () => {
  it('formats claude-opus-4-6 model names', () => {
    expect(ThreadHeaderBuilder.formatModelName('claude-opus-4-6-20250414')).toBe('opus-4.6');
  });

  it('formats claude-sonnet-4-5 model names', () => {
    expect(ThreadHeaderBuilder.formatModelName('claude-sonnet-4-5-20250414')).toBe('sonnet-4.5');
  });

  it('handles unrecognized format gracefully', () => {
    expect(ThreadHeaderBuilder.formatModelName('custom-model')).toBe('custom-model');
  });

  // --- Issue #656: [1m] variants render with " (1M)" suffix ---

  it('formats claude-opus-4-7[1m] with (1M) suffix', () => {
    expect(ThreadHeaderBuilder.formatModelName('claude-opus-4-7[1m]')).toBe('opus-4.7 (1M)');
  });

  it('formats claude-opus-4-6[1m] with (1M) suffix', () => {
    expect(ThreadHeaderBuilder.formatModelName('claude-opus-4-6[1m]')).toBe('opus-4.6 (1M)');
  });

  it('formats claude-opus-4-7[1M] (uppercase) with (1M) suffix', () => {
    expect(ThreadHeaderBuilder.formatModelName('claude-opus-4-7[1M]')).toBe('opus-4.7 (1M)');
  });

  it('formats claude-opus-4-7 (bare) without any suffix', () => {
    expect(ThreadHeaderBuilder.formatModelName('claude-opus-4-7')).toBe('opus-4.7');
  });

  it('formats claude-sonnet-4-6 (bare) without any suffix', () => {
    expect(ThreadHeaderBuilder.formatModelName('claude-sonnet-4-6')).toBe('sonnet-4.6');
  });

  it('strips date suffix from dated bare ids', () => {
    expect(ThreadHeaderBuilder.formatModelName('claude-haiku-4-5-20251001')).toBe('haiku-4.5');
  });
});

describe('ThreadHeaderBuilder.formatTokenCount', () => {
  it('formats millions', () => {
    expect(ThreadHeaderBuilder.formatTokenCount(1_000_000)).toBe('1M');
    expect(ThreadHeaderBuilder.formatTokenCount(1_500_000)).toBe('1.5M');
  });

  it('formats thousands', () => {
    expect(ThreadHeaderBuilder.formatTokenCount(200_000)).toBe('200k');
    expect(ThreadHeaderBuilder.formatTokenCount(156_700)).toBe('156.7k');
  });

  it('formats small numbers as-is', () => {
    expect(ThreadHeaderBuilder.formatTokenCount(500)).toBe('500');
  });
});

describe('ThreadHeaderBuilder.formatContextBar', () => {
  it('returns undefined when no usage', () => {
    expect(ThreadHeaderBuilder.formatContextBar(undefined)).toBeUndefined();
  });

  it('shows correct bar segments for 15% used', () => {
    const usage: SessionUsage = {
      currentInputTokens: 100_000,
      currentOutputTokens: 50_000,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      contextWindow: 1_000_000,
      totalInputTokens: 100_000,
      totalOutputTokens: 50_000,
      totalCacheReadTokens: 0,
      totalCacheCreateTokens: 0,
      totalCostUsd: 0,
      lastUpdated: Date.now(),
    };

    const bar = ThreadHeaderBuilder.formatContextBar(usage);
    expect(bar).toBeDefined();
    // 15% used → 1 filled of 5
    expect(bar).toBe('▓░░░░ 150k/1M (85%)');
  });

  it('shows full bar for 100% used', () => {
    const usage: SessionUsage = {
      currentInputTokens: 800_000,
      currentOutputTokens: 200_000,
      currentCacheReadTokens: 0,
      currentCacheCreateTokens: 0,
      contextWindow: 1_000_000,
      totalInputTokens: 800_000,
      totalOutputTokens: 200_000,
      totalCacheReadTokens: 0,
      totalCacheCreateTokens: 0,
      totalCostUsd: 0,
      lastUpdated: Date.now(),
    };

    const bar = ThreadHeaderBuilder.formatContextBar(usage);
    expect(bar).toBe('▓▓▓▓▓ 1M/1M (0%)');
  });
});
