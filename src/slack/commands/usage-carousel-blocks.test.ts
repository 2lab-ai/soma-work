import { describe, expect, it } from 'vitest';
import type { TabId } from '../../metrics/usage-render/types';
import { buildCarouselBlocks } from './usage-carousel-blocks';

// Trace: docs/usage-card-dark/trace.md — Scenario 1 (lines 60–61) + Scenario 8 (line 232).
// Asserts option/value shape only. SVG DOM / visual assertions forbidden.

const FILE_IDS: Record<TabId, string> = {
  '24h': 'F1',
  '7d': 'F2',
  '30d': 'F3',
  all: 'F4',
};

describe('buildCarouselBlocks', () => {
  it('returns 3 blocks in order: context, image, actions', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '30d', 'U_ME') as any[];
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('context');
    expect(blocks[1].type).toBe('image');
    expect(blocks[2].type).toBe('actions');
  });

  it('context block attributes the caller via <@userId>', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '30d', 'U_ME') as any[];
    const ctx = blocks[0];
    expect(ctx.elements).toHaveLength(1);
    expect(ctx.elements[0].type).toBe('mrkdwn');
    expect(ctx.elements[0].text).toContain('<@U_ME>');
  });

  it('selectedTab="30d" → image slack_file.id === fileIds["30d"]', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '30d', 'U_ME') as any[];
    expect(blocks[1].slack_file).toEqual({ id: 'F3' });
    expect(blocks[1].alt_text).toBe('Usage card (30d)');
  });

  it('selectedTab="7d" → image slack_file.id === fileIds["7d"]', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '7d', 'U_ME') as any[];
    expect(blocks[1].slack_file).toEqual({ id: 'F2' });
  });

  it('actions block has static block_id "usage_card_tabs" (no messageTs)', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '30d', 'U_ME') as any[];
    expect(blocks[2].block_id).toBe('usage_card_tabs');
  });

  it('actions contains 4 buttons in order 24h, 7d, 30d, all', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '30d', 'U_ME') as any[];
    const elements = blocks[2].elements;
    expect(elements).toHaveLength(4);
    expect(elements.map((e: any) => e.value)).toEqual(['24h', '7d', '30d', 'all']);
    for (const el of elements) {
      expect(el.type).toBe('button');
      expect(el.action_id).toBe('usage_card_tab');
      expect(el.text.type).toBe('plain_text');
    }
  });

  it('selectedTab="30d" → 30d button has style:"primary", others do not', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '30d', 'U_ME') as any[];
    const elements = blocks[2].elements;
    expect(elements[0].style).toBeUndefined(); // 24h
    expect(elements[1].style).toBeUndefined(); // 7d
    expect(elements[2].style).toBe('primary'); // 30d
    expect(elements[3].style).toBeUndefined(); // all
  });

  it('selectedTab="7d" → 7d button primary, 30d button has no style', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '7d', 'U_ME') as any[];
    const elements = blocks[2].elements;
    expect(elements[0].style).toBeUndefined();
    expect(elements[1].style).toBe('primary');
    expect(elements[2].style).toBeUndefined();
    expect(elements[3].style).toBeUndefined();
  });

  it('button labels are human-readable', () => {
    const blocks = buildCarouselBlocks(FILE_IDS, '30d', 'U_ME') as any[];
    const labels = blocks[2].elements.map((e: any) => e.text.text);
    expect(labels).toEqual(['Last 24h', 'Last 7d', 'Last 30d', 'All time']);
  });
});
