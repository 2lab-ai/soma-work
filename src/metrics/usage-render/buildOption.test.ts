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
});
