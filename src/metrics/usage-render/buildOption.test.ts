import { describe, expect, it } from 'vitest';
import { buildOption, CANVAS_HEIGHT, CANVAS_WIDTH, HEATMAP_PALETTE } from './buildOption';
import type { UsageCardStats } from './types';

// Trace: docs/usage-card/trace.md, Scenario 5

function makeStats(partial: Partial<UsageCardStats> = {}): UsageCardStats {
  const heatmap = Array.from({ length: 42 }, (_, i) => ({
    date: i >= 12 ? `2026-04-${String((i - 12 + 1) % 31 || 1).padStart(2, '0')}` : '',
    tokens: i >= 12 ? ((i - 12) * 100) % 5000 : 0,
    cellIndex: i,
  }));
  return {
    empty: false,
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    windowStart: '2026-03-20',
    windowEnd: '2026-04-18',
    totals: { last24h: 12_345, last7d: 50_000, last30d: 1_234_567, costLast30dUsd: 7.89 },
    heatmap,
    hourly: Array.from({ length: 24 }, (_, h) => h * 100),
    rankings: {
      tokensTop: [
        { userId: 'U_TEST', userName: 'Tester', totalTokens: 1_234_567, totalCost: 7.89, rank: 1 },
        { userId: 'U_B', userName: 'B', totalTokens: 900_000, totalCost: 5.0, rank: 2 },
      ],
      costTop: [{ userId: 'U_TEST', userName: 'Tester', totalTokens: 1_234_567, totalCost: 7.89, rank: 1 }],
      targetTokenRow: null,
      targetCostRow: null,
    },
    sessions: {
      tokenTop3: [{ sessionKey: 'S1', totalTokens: 500_000, durationMs: 3_600_000, firstEventAt: '', lastEventAt: '' }],
      spanTop3: [{ sessionKey: 'S2', totalTokens: 100_000, durationMs: 7_200_000, firstEventAt: '', lastEventAt: '' }],
    },
    favoriteModel: { model: 'claude-opus-4-7', tokens: 800_000 },
    currentStreakDays: 5,
    totalSessions: 9,
    ...partial,
  };
}

describe('buildOption', () => {
  it('returns deterministic option shape with 2 grids', () => {
    const opt = buildOption(makeStats());
    expect(opt.grid).toHaveLength(2);
    expect(opt.xAxis).toHaveLength(2);
    expect(opt.yAxis).toHaveLength(2);
  });

  it('heatmap series has 42 data points (7×6 grid)', () => {
    const opt = buildOption(makeStats());
    const heatmapSeries = opt.series.find((s: any) => s.id === 'heatmap') as any;
    expect(heatmapSeries).toBeDefined();
    expect(heatmapSeries.data).toHaveLength(42);
  });

  it('hourly series has 24 data points', () => {
    const opt = buildOption(makeStats());
    const hourly = opt.series.find((s: any) => s.id === 'hourly') as any;
    expect(hourly.data).toHaveLength(24);
  });

  it('visualMap pieces use HEATMAP_PALETTE colors', () => {
    const opt = buildOption(makeStats());
    const vm = opt.visualMap[0] as any;
    expect(vm.type).toBe('piecewise');
    expect(vm.pieces.length).toBeGreaterThanOrEqual(1);
    const paletteSet = new Set(HEATMAP_PALETTE);
    for (const p of vm.pieces) {
      expect(paletteSet.has(p.color)).toBe(true);
    }
  });

  it('HEATMAP_PALETTE is the GitHub-style 5-tone green scale', () => {
    expect(HEATMAP_PALETTE).toEqual(['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']);
  });

  it('all-zero heatmap → single uniform bucket', () => {
    const stats = makeStats({
      heatmap: Array.from({ length: 42 }, (_, i) => ({ date: i >= 12 ? `d${i}` : '', tokens: 0, cellIndex: i })),
    });
    const opt = buildOption(stats);
    const vm = opt.visualMap[0] as any;
    expect(vm.pieces).toHaveLength(1);
    expect(vm.pieces[0].color).toBe(HEATMAP_PALETTE[0]);
  });

  it('is deterministic (same input → equal JSON)', () => {
    const a = buildOption(makeStats());
    const b = buildOption(makeStats());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('canvas dims exported constants match contract', () => {
    expect(CANVAS_WIDTH).toBe(1600);
    expect(CANVAS_HEIGHT).toBe(2200);
  });

  describe('target-user visibility (rankings P0)', () => {
    const otherTop = [
      { userId: 'U_A', userName: 'A', totalTokens: 9_000_000, totalCost: 50.0, rank: 1 },
      { userId: 'U_B', userName: 'B', totalTokens: 8_000_000, totalCost: 40.0, rank: 2 },
      { userId: 'U_C', userName: 'C', totalTokens: 7_000_000, totalCost: 30.0, rank: 3 },
      { userId: 'U_D', userName: 'D', totalTokens: 6_000_000, totalCost: 20.0, rank: 4 },
      { userId: 'U_E', userName: 'E', totalTokens: 5_000_000, totalCost: 10.0, rank: 5 },
    ];

    it('target inside top-5 → NO overflow separator/row added', () => {
      const stats = makeStats({
        targetUserId: 'U_A',
        targetUserName: 'A',
        rankings: {
          tokensTop: otherTop,
          costTop: otherTop,
          targetTokenRow: null,
          targetCostRow: null,
        },
      });
      const opt = buildOption(stats);
      const texts = opt.graphic.map((g: any) => (g.style?.text as string) || '');
      // No lone "…" separator should appear when target is already visible.
      expect(texts).not.toContain('…');
    });

    it('target ranked 8th → overflow row rendered with rank=8 text + "…" separator', () => {
      const target = { userId: 'U_TEST', userName: 'Tester', totalTokens: 1_234_567, totalCost: 7.89, rank: 8 };
      const stats = makeStats({
        rankings: {
          tokensTop: otherTop,
          costTop: otherTop,
          targetTokenRow: target,
          targetCostRow: target,
        },
      });
      const opt = buildOption(stats);
      const texts = opt.graphic.map((g: any) => (g.style?.text as string) || '');
      // "…" separator appears (at least twice — once per column).
      expect(texts.filter((t: string) => t === '…').length).toBeGreaterThanOrEqual(2);
      // Target's real rank (8) appears in an overflow row.
      expect(texts.some((t: string) => t.startsWith('8. Tester'))).toBe(true);
    });
  });

  describe('KPI strip + fun-fact footer contents', () => {
    it('KPI labels (24시간, 7일, 30일, 비용, 연속, 세션) are all present', () => {
      const opt = buildOption(makeStats());
      const texts = opt.graphic.map((g: any) => (g.style?.text as string) || '');
      for (const label of ['24시간', '7일', '30일', '비용(30일)', '연속', '세션']) {
        expect(texts).toContain(label);
      }
    });

    it('30일 KPI value includes formatted total tokens', () => {
      const opt = buildOption(makeStats({ totals: { last24h: 1, last7d: 2, last30d: 1_234_567, costLast30dUsd: 0 } }));
      const texts = opt.graphic.map((g: any) => (g.style?.text as string) || '');
      expect(texts).toContain('1,234,567');
    });

    it('cost KPI formatted as $0.00 style (en-US)', () => {
      const opt = buildOption(makeStats({ totals: { last24h: 0, last7d: 0, last30d: 1, costLast30dUsd: 3.456 } }));
      const texts = opt.graphic.map((g: any) => (g.style?.text as string) || '');
      expect(texts).toContain('$3.46');
    });

    it('favoriteModel null → renders em-dash placeholder', () => {
      const opt = buildOption(makeStats({ favoriteModel: null }));
      const texts = opt.graphic.map((g: any) => (g.style?.text as string) || '');
      expect(texts.some((t: string) => t.includes('즐겨 쓰는 모델: —'))).toBe(true);
    });

    it('title contains user name + date window', () => {
      const opt = buildOption(
        makeStats({ targetUserName: '주군', windowStart: '2026-03-20', windowEnd: '2026-04-18' }),
      );
      const titleText = (opt.title[0] as any).text as string;
      expect(titleText).toContain('주군');
      expect(titleText).toContain('2026-03-20');
      expect(titleText).toContain('2026-04-18');
    });
  });
});
