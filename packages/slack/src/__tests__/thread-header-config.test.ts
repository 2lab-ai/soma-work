/**
 * Thread header × ui.threadheader surface config — RED tests.
 *
 * The thread header must be composed from getSurfaceLines('threadheader', theme)
 * instead of hardcoded theme builders, while the built-in defaults keep exact
 * parity with the pre-config output (pinned literal below, captured from the
 * pre-rewrite implementation).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resetUiSurfacesConfig, setUiSurfacesConfig } from '../surface-config';
import { type SessionUsage, ThreadHeaderBuilder, type ThreadHeaderData } from '../thread-header-builder';

afterEach(() => {
  resetUiSurfacesConfig();
});

function makeUsage(): SessionUsage {
  return {
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
    lastUpdated: 1_750_000_000_000,
  };
}

function makeData(overrides?: Partial<ThreadHeaderData>): ThreadHeaderData {
  return {
    title: 'Fix login bug',
    workflow: 'z',
    ownerName: 'Kim',
    ownerId: 'U123',
    model: 'claude-opus-4-6-20250414',
    usage: makeUsage(),
    links: {
      issue: { url: 'https://linear.app/x/issue/SOMA-1', type: 'issue', label: 'SOMA-1' },
      pr: { url: 'https://github.com/org/repo/pull/10', type: 'pr', label: 'PR #10' },
    },
    linkHistory: {
      issues: [
        {
          url: 'https://linear.app/x/issue/SOMA-1',
          type: 'issue',
          label: 'SOMA-1',
          title: 'Fix login bug',
          status: 'In Progress',
        },
      ],
      prs: [{ url: 'https://github.com/org/repo/pull/10', type: 'pr', label: 'PR #10', status: 'open' }],
    },
    closed: true,
    ...overrides,
  };
}

function allTexts(blocks: any[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block?.text?.text === 'string') parts.push(block.text.text);
    if (Array.isArray(block?.elements)) {
      for (const el of block.elements) {
        if (typeof el?.text === 'string') parts.push(el.text);
      }
    }
  }
  return parts.join(' ');
}

describe('ThreadHeaderBuilder × ui.threadheader config', () => {
  it('custom lines replace the default composition (no owner/workflow/bar)', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [
          { block: 'header', fields: [{ field: 'title' }] },
          { block: 'context', fields: [{ field: 'model' }] },
        ],
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData());
    const blocks = payload.blocks || [];

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.text).toBe('Fix login bug');
    expect(blocks[1].type).toBe('context');

    const text = allTexts(blocks);
    expect(text).not.toContain('<@U123>');
    expect(text).not.toContain('`z`');
    expect(text).not.toContain('▓');
    expect(text).not.toContain('░');
  });

  it('field order in config drives element order (model before workflow)', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [
          {
            block: 'context',
            fields: [
              { field: 'model', style: { code: true } },
              { field: 'workflow', style: { code: true } },
            ],
          },
        ],
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData());
    const context = (payload.blocks || [])[0];
    const texts = context.elements.map((el: any) => el.text);
    expect(texts.indexOf('`opus-4.6`')).toBeLessThan(texts.indexOf('`z`'));
  });

  it('show:false hides a field', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [
          {
            block: 'context',
            fields: [
              { field: 'owner', format: 'mention' },
              { field: 'workflow', show: false },
              { field: 'model', style: { code: true } },
            ],
          },
        ],
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData());
    const text = allTexts(payload.blocks || []);
    expect(text).toContain('<@U123>');
    expect(text).toContain('opus-4.6');
    expect(text).not.toContain('z');
  });

  it('custom bar width and chars apply to the context window bar', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [
          {
            block: 'context',
            fields: [{ field: 'contextwindow', bar: { width: 8, filledChar: '█', emptyChar: '·' } }],
          },
        ],
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData());
    const text = allTexts(payload.blocks || []);
    // 15% used of 8 segments → 1 filled, 7 empty
    expect(text).toContain('█·······');
    expect(text).toContain('150k/1M (85%)');
    expect(text).not.toContain('▓');
  });

  it('style bold on workflow renders *z* instead of `z`', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [{ block: 'context', fields: [{ field: 'workflow', style: { bold: true } }] }],
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData());
    const text = allTexts(payload.blocks || []);
    expect(text).toContain('*z*');
    expect(text).not.toContain('`z`');
  });

  it('surface-level user lines apply to the compact theme too', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [
          { block: 'header', fields: [{ field: 'title' }] },
          { block: 'context', fields: [{ field: 'model', style: { code: true } }] },
        ],
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData({ theme: 'compact' }));
    const blocks = payload.blocks || [];
    expect(blocks[0].type).toBe('header');
    const text = allTexts(blocks);
    // Compact's hardcoded headline "🔴 *Kim — Fix login bug*" must be gone
    expect(text).not.toContain('Kim — Fix login bug');
    expect(text).toContain('`opus-4.6`');
  });

  it('chunks context lines with more than 10 elements into multiple blocks', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [{ block: 'context', fields: [{ field: 'linkhistory', max: 12 }] }],
      },
    });

    const issues = Array.from({ length: 12 }, (_, i) => ({
      url: `https://linear.app/x/issue/SOMA-${i + 1}`,
      type: 'issue',
      label: `SOMA-${i + 1}`,
    }));

    const payload = ThreadHeaderBuilder.build(makeData({ linkHistory: { issues } }));
    const blocks = (payload.blocks || []).filter((b: any) => b.type === 'context');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].elements).toHaveLength(10);
    expect(blocks[1].elements).toHaveLength(2);
    expect(blocks[1].elements[1].text).toContain('SOMA-12');
  });

  it('divider block type renders a Slack divider', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [
          { block: 'header', fields: [{ field: 'title' }] },
          { block: 'divider', fields: [{ field: 'separator' }] },
          { block: 'context', fields: [{ field: 'model' }] },
        ],
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData());
    expect((payload.blocks || [])[1]).toEqual({ type: 'divider' });
  });

  it('a line whose fields all render empty is omitted entirely', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [
          { block: 'header', fields: [{ field: 'title' }] },
          { block: 'context', fields: [{ field: 'status', format: 'closed-marker' }] },
        ],
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData({ closed: false }));
    expect(payload.blocks).toHaveLength(1);
    expect((payload.blocks || [])[0].type).toBe('header');
  });

  // -------------------------------------------------------------------------
  // Default parity — pinned literal output captured from the pre-rewrite
  // implementation (hardcoded theme builders). MUST NOT change.
  // -------------------------------------------------------------------------

  it('default theme output deep-equals the pre-rewrite output (no config)', () => {
    const payload = ThreadHeaderBuilder.build(makeData({ theme: 'default' }));
    expect(payload).toEqual({
      text: 'Fix login bug\nKim',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Fix login bug', emoji: true },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: '<@U123>' },
            { type: 'mrkdwn', text: '`z`' },
            { type: 'mrkdwn', text: '`opus-4.6`' },
            { type: 'mrkdwn', text: '▓░░░░ 150k/1M (85%)' },
          ],
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: '📋 <https://linear.app/x/issue/SOMA-1|SOMA-1>: Fix login bug 🔵' },
            { type: 'mrkdwn', text: '🔀 <https://github.com/org/repo/pull/10|PR #10> 🟢' },
          ],
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '🔴 _종료됨_' }],
        },
      ],
    });
  });

  it('compact theme output deep-equals the pre-rewrite output (no config)', () => {
    const payload = ThreadHeaderBuilder.build(makeData({ theme: 'compact' }));
    expect(payload).toEqual({
      text: 'Fix login bug\nKim',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '🔴 *Kim — Fix login bug*' },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: '`z`' },
            { type: 'mrkdwn', text: '`opus-4.6`' },
            { type: 'mrkdwn', text: '▓░░░░ 150k/1M (85%)' },
            { type: 'mrkdwn', text: '<https://linear.app/x/issue/SOMA-1|SOMA-1>' },
            { type: 'mrkdwn', text: '<https://github.com/org/repo/pull/10|PR #10>' },
            { type: 'mrkdwn', text: '_종료됨_' },
          ],
        },
      ],
    });
  });

  it('minimal theme output deep-equals the pre-rewrite output (no config)', () => {
    const payload = ThreadHeaderBuilder.build(makeData({ theme: 'minimal' }));
    expect(payload).toEqual({
      text: 'Fix login bug\nKim',
      blocks: [
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'Fix login bug' },
            { type: 'mrkdwn', text: '`opus-4.6`' },
            { type: 'mrkdwn', text: '▓░░░░ 150k/1M (85%)' },
            { type: 'mrkdwn', text: '<https://linear.app/x/issue/SOMA-1|SOMA-1>' },
            { type: 'mrkdwn', text: '<https://github.com/org/repo/pull/10|PR #10>' },
            { type: 'mrkdwn', text: '_종료됨_' },
          ],
        },
      ],
    });
  });
});

describe('ThreadHeaderBuilder.formatContextBar bar-style overload', () => {
  it('keeps the default 5-segment ▓░ style when called with usage only', () => {
    expect(ThreadHeaderBuilder.formatContextBar(makeUsage())).toBe('▓░░░░ 150k/1M (85%)');
  });

  it('accepts a custom bar style', () => {
    expect(ThreadHeaderBuilder.formatContextBar(makeUsage(), { width: 8, filledChar: '█', emptyChar: '·' })).toBe(
      '█······· 150k/1M (85%)',
    );
  });
});
