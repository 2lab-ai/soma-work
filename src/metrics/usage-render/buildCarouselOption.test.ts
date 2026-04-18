/**
 * RED tests for per-tab ECharts option builder (v2 carousel).
 * Trace: docs/usage-card-dark/trace.md — Scenario 3.
 *
 * Tests assert ECharts option object shape (values), NOT SVG output.
 */

import { describe, expect, it } from 'vitest';
import { buildCardOption, buildStubOption, buildTabOption } from './buildCarouselOption';
import { DARK_PALETTE, HEATMAP_SCALE } from './dark-palette';
import type { CarouselStats, CarouselTabStats, EmptyTabStats, TabId } from './types';

// ───── Fixtures ────────────────────────────────────────────────────────

function makeNonEmptyStats(tabId: TabId, overrides: Partial<CarouselTabStats> = {}): CarouselTabStats {
  let heatmap: CarouselTabStats['heatmap'] = [];
  if (tabId === '7d') {
    // 168 cells (7 days × 24 hours)
    heatmap = Array.from({ length: 168 }, (_, i) => ({
      date: `2026-04-${String((Math.floor(i / 24) % 30) + 1).padStart(2, '0')}`,
      tokens: (i * 37) % 1000,
      cellIndex: i,
    }));
  } else if (tabId === '30d') {
    // 35 cells (5 rows × 7 cols)
    heatmap = Array.from({ length: 35 }, (_, i) => ({
      date: `2026-04-${String((i % 30) + 1).padStart(2, '0')}`,
      tokens: (i * 113) % 2000,
      cellIndex: i,
    }));
  } else if (tabId === 'all') {
    // 84 cells (12 months × 7 weekdays)
    heatmap = Array.from({ length: 84 }, (_, i) => ({
      date: `2026-${String((Math.floor(i / 7) % 12) + 1).padStart(2, '0')}-01`,
      tokens: (i * 251) % 3000,
      cellIndex: i,
    }));
  }

  return {
    empty: false,
    tabId,
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    windowStart: '2026-03-20',
    windowEnd: '2026-04-18',
    totals: {
      tokens: 123_456,
      costUsd: 4.56,
      sessions: 7,
    },
    favoriteModel: { model: 'claude-opus-4-7', tokens: 80_000 },
    hourly: Array.from({ length: 24 }, (_, h) => h * 100),
    heatmap,
    rankings: {
      tokensTop: [{ userId: 'U_TEST', userName: 'Tester', totalTokens: 123_456, rank: 12 }],
      targetTokenRow: null,
    },
    activeDays: 18,
    longestStreakDays: 5,
    currentStreakDays: 3,
    topSessions: [{ sessionKey: 'S1', totalTokens: 50_000, durationMs: 3_600_000 }],
    longestSession: { sessionKey: 'S2', durationMs: 7_200_000 },
    mostActiveDay: { date: '2026-04-10', tokens: 9_999 },
    ...overrides,
  };
}

function makeEmpty(tabId: TabId): EmptyTabStats {
  return {
    empty: true,
    tabId,
    windowStart: '2026-03-20',
    windowEnd: '2026-04-18',
  };
}

function makeCarouselStats(overrides: Partial<Record<TabId, CarouselTabStats | EmptyTabStats>> = {}): CarouselStats {
  return {
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    now: '2026-04-18T12:00:00+09:00',
    tabs: {
      '24h': overrides['24h'] ?? makeNonEmptyStats('24h'),
      '7d': overrides['7d'] ?? makeNonEmptyStats('7d'),
      '30d': overrides['30d'] ?? makeNonEmptyStats('30d'),
      all: overrides.all ?? makeNonEmptyStats('all'),
    },
  };
}

// ───── buildTabOption per tab ───────────────────────────────────────────

describe('buildTabOption', () => {
  it('24h — bar chart with 24 bins, no visualMap', () => {
    const opt = buildTabOption('24h', makeNonEmptyStats('24h'), false) as any;
    expect(Array.isArray(opt.series)).toBe(true);
    expect(opt.series).toHaveLength(1);
    expect(opt.series[0].type).toBe('bar');
    expect(opt.series[0].data).toHaveLength(24);
    expect(opt.visualMap).toBeUndefined();
    // xAxis may be a single object or an array; normalize
    const xAxis = Array.isArray(opt.xAxis) ? opt.xAxis[0] : opt.xAxis;
    expect(xAxis.data).toHaveLength(24);
    expect(opt.backgroundColor).toBe(DARK_PALETTE.bg);
  });

  it('7d — heatmap ≤ 168 cells with 5-piece visualMap using HEATMAP_SCALE', () => {
    const opt = buildTabOption('7d', makeNonEmptyStats('7d'), false) as any;
    expect(opt.series[0].type).toBe('heatmap');
    expect(opt.series[0].data.length).toBeLessThanOrEqual(168);
    expect(opt.visualMap).toBeDefined();
    expect(opt.visualMap.pieces).toHaveLength(5);
    const colors = opt.visualMap.pieces.map((p: any) => p.color);
    expect(colors).toEqual([...HEATMAP_SCALE]);
  });

  it('30d — heatmap ≤ 35 cells with 5-piece visualMap', () => {
    const opt = buildTabOption('30d', makeNonEmptyStats('30d'), false) as any;
    expect(opt.series[0].type).toBe('heatmap');
    expect(opt.series[0].data.length).toBeLessThanOrEqual(35);
    expect(opt.visualMap.pieces).toHaveLength(5);
  });

  it('all — heatmap ≤ 84 cells with 5-piece visualMap', () => {
    const opt = buildTabOption('all', makeNonEmptyStats('all'), false) as any;
    expect(opt.series[0].type).toBe('heatmap');
    expect(opt.series[0].data.length).toBeLessThanOrEqual(84);
    expect(opt.visualMap.pieces).toHaveLength(5);
  });

  it('empty tab → stub option with dark bg + "활동 없음" message', () => {
    const opt = buildTabOption('30d', makeEmpty('30d'), false) as any;
    expect(opt.backgroundColor).toBe(DARK_PALETTE.bg);
    // Either graphic.text or title.text should contain the empty marker substring.
    const titleText = (() => {
      if (!opt.title) return '';
      if (Array.isArray(opt.title)) return opt.title.map((t: any) => t?.text ?? '').join(' ');
      return opt.title.text ?? '';
    })();
    const graphicText = (() => {
      if (!opt.graphic) return '';
      const arr = Array.isArray(opt.graphic) ? opt.graphic : [opt.graphic];
      return arr.map((g: any) => g?.style?.text ?? g?.text ?? '').join(' ');
    })();
    expect(`${titleText} ${graphicText}`).toContain('활동 없음');
  });

  it('cell count matches heatmap input length — 7d', () => {
    const stats = makeNonEmptyStats('7d', {
      heatmap: Array.from({ length: 42 }, (_, i) => ({
        date: '2026-04-10',
        tokens: i,
        cellIndex: i,
      })),
    });
    const opt = buildTabOption('7d', stats, false) as any;
    expect(opt.series[0].data).toHaveLength(42);
  });

  it('cell count matches heatmap input length — 30d', () => {
    const stats = makeNonEmptyStats('30d', {
      heatmap: Array.from({ length: 20 }, (_, i) => ({
        date: '2026-04-10',
        tokens: i,
        cellIndex: i,
      })),
    });
    const opt = buildTabOption('30d', stats, false) as any;
    expect(opt.series[0].data).toHaveLength(20);
  });

  it('cell count matches heatmap input length — all', () => {
    const stats = makeNonEmptyStats('all', {
      heatmap: Array.from({ length: 50 }, (_, i) => ({
        date: '2026-04-10',
        tokens: i,
        cellIndex: i,
      })),
    });
    const opt = buildTabOption('all', stats, false) as any;
    expect(opt.series[0].data).toHaveLength(50);
  });

  it('assertions are object-based, not SVG string grep (smoke)', () => {
    const opt = buildTabOption('7d', makeNonEmptyStats('7d'), false) as any;
    // Direct property access — never stringify and substring-match SVG.
    expect(opt.series[0].type).toBe('heatmap');
  });
});

// ───── buildStubOption ──────────────────────────────────────────────────

describe('buildStubOption', () => {
  it.each([
    '24h',
    '7d',
    '30d',
    'all',
  ] as const)('returns dark-bg option with localized empty message for %s', (tabId) => {
    const opt = buildStubOption(tabId) as any;
    expect(opt.backgroundColor).toBe(DARK_PALETTE.bg);
    const titleText = (() => {
      if (!opt.title) return '';
      if (Array.isArray(opt.title)) return opt.title.map((t: any) => t?.text ?? '').join(' ');
      return opt.title.text ?? '';
    })();
    const graphicText = (() => {
      if (!opt.graphic) return '';
      const arr = Array.isArray(opt.graphic) ? opt.graphic : [opt.graphic];
      return arr.map((g: any) => g?.style?.text ?? g?.text ?? '').join(' ');
    })();
    expect(`${titleText} ${graphicText}`).toContain('활동 없음');
  });
});

// ───── buildCardOption / selected-flag visual ───────────────────────────

describe('buildCardOption', () => {
  it('period-tab graphic highlights the selected tab with DARK_PALETTE.accent, others surface', () => {
    const carousel = makeCarouselStats();
    const opt = buildCardOption(carousel, '30d', true) as any;

    const graphics = Array.isArray(opt.graphic) ? opt.graphic : [opt.graphic];
    // Find period-tab pills by their tag/id or by presence of tab text.
    const tabGraphics = graphics.filter(
      (g: any) => g?.periodTab === true || g?.id?.toString?.().startsWith?.('period-tab-'),
    );
    expect(tabGraphics.length).toBeGreaterThanOrEqual(4);

    const selected = tabGraphics.find((g: any) => g.id === 'period-tab-30d' || g.periodTabId === '30d');
    const other = tabGraphics.find((g: any) => g.id === 'period-tab-24h' || g.periodTabId === '24h');
    expect(selected).toBeDefined();
    expect(other).toBeDefined();

    const selectedFill =
      selected?.style?.fill ?? selected?.style?.backgroundColor ?? selected?.fill ?? selected?.backgroundColor;
    const otherFill = other?.style?.fill ?? other?.style?.backgroundColor ?? other?.fill ?? other?.backgroundColor;

    expect(selectedFill).toBe(DARK_PALETTE.accent);
    expect(otherFill).toBe(DARK_PALETTE.surface);
  });

  it('uses dark backgroundColor', () => {
    const opt = buildCardOption(makeCarouselStats(), '30d', true) as any;
    expect(opt.backgroundColor).toBe(DARK_PALETTE.bg);
  });

  it('renders empty tab via stub when selected tab is empty', () => {
    const carousel = makeCarouselStats({ '30d': makeEmpty('30d') });
    const opt = buildCardOption(carousel, '30d', true) as any;
    expect(opt.backgroundColor).toBe(DARK_PALETTE.bg);
    const graphics = Array.isArray(opt.graphic) ? opt.graphic : [opt.graphic];
    const titleText = (() => {
      if (!opt.title) return '';
      if (Array.isArray(opt.title)) return opt.title.map((t: any) => t?.text ?? '').join(' ');
      return opt.title.text ?? '';
    })();
    const allText = `${graphics.map((g: any) => g?.style?.text ?? g?.text ?? '').join(' ')} ${titleText}`;
    expect(allText).toContain('활동 없음');
  });
});
