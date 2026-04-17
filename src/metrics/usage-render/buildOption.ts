/**
 * ECharts option builder for `/usage card`.
 * Trace: docs/usage-card/trace.md, Scenario 5
 *
 * Deterministic given a fixed `UsageCardStats` (no Date.now() calls).
 */

import { pickFunFact } from './fun-facts';
import type { UsageCardStats } from './types';

export const HEATMAP_PALETTE = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'] as const;

export const CANVAS_WIDTH = 1600;
export const CANVAS_HEIGHT = 2200;

const FONT_FAMILY = 'Noto Sans KR';

interface EChartsOptionLike {
  backgroundColor?: string;
  textStyle?: Record<string, unknown>;
  grid: Record<string, unknown>[];
  xAxis: Record<string, unknown>[];
  yAxis: Record<string, unknown>[];
  visualMap: Record<string, unknown>[];
  series: Record<string, unknown>[];
  graphic: Record<string, unknown>[];
  title: Record<string, unknown>[];
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

function percentileOfNonZero(values: number[], p: number): number {
  const nonzero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonzero.length === 0) return 0;
  const idx = Math.min(nonzero.length - 1, Math.floor((p / 100) * nonzero.length));
  return nonzero[idx];
}

function buildHeatmapPieces(
  heatmap: UsageCardStats['heatmap'],
): Array<{ min?: number; max?: number; color: string; label?: string }> {
  const realTokens = heatmap.filter((c) => c.date !== '').map((c) => c.tokens);
  const p95 = percentileOfNonZero(realTokens, 95);

  if (p95 <= 0) {
    // All zero → single uniform bucket.
    return [{ min: 0, max: 0, color: HEATMAP_PALETTE[0], label: '0' }];
  }

  // 4 equal splits below p95 + overflow bucket ≥ p95.
  const step = p95 / 4;
  return [
    { min: 0, max: 0, color: HEATMAP_PALETTE[0], label: '0' },
    { min: 1, max: Math.max(1, Math.round(step)), color: HEATMAP_PALETTE[1] },
    { min: Math.max(2, Math.round(step) + 1), max: Math.max(2, Math.round(step * 2)), color: HEATMAP_PALETTE[2] },
    { min: Math.max(3, Math.round(step * 2) + 1), max: Math.max(3, Math.round(step * 3)), color: HEATMAP_PALETTE[3] },
    { min: Math.max(4, Math.round(step * 3) + 1), color: HEATMAP_PALETTE[4], label: `≥ ${fmt(Math.round(p95))}` },
  ];
}

export function buildOption(stats: UsageCardStats): EChartsOptionLike {
  const title = `📊 ${stats.targetUserName || stats.targetUserId}님의 사용량 카드 · ${stats.windowStart} ~ ${stats.windowEnd}`;
  const funFact = pickFunFact(stats.totals.last30d);

  // Heatmap data: [col, row, tokens] triples, one per cell.
  const heatmapData = stats.heatmap.map((c) => {
    const col = c.cellIndex % 7;
    const row = Math.floor(c.cellIndex / 7);
    return [col, row, c.tokens];
  });

  const pieces = buildHeatmapPieces(stats.heatmap);

  // Hourly bar chart
  const hourlyCategories = Array.from({ length: 24 }, (_, h) => `${h}시`);

  // KPI strip text
  const kpiStrip = [
    { label: '24시간', value: fmt(stats.totals.last24h) },
    { label: '7일', value: fmt(stats.totals.last7d) },
    { label: '30일', value: fmt(stats.totals.last30d) },
    { label: '비용(30일)', value: `$${stats.totals.costLast30dUsd.toFixed(2)}` },
    { label: '연속', value: `${stats.currentStreakDays}일` },
    { label: '세션', value: `${stats.totalSessions}개` },
  ];

  // Grids — indices assigned in creation order.
  // 0: heatmap
  // 1: hourly bar
  const grids: Record<string, unknown>[] = [
    { id: 'heatmap', left: 120, right: 120, top: 320, height: 360 },
    { id: 'hourly', left: 120, right: 120, top: 780, height: 260 },
  ];

  const xAxes: Record<string, unknown>[] = [
    {
      gridIndex: 0,
      type: 'category',
      data: ['일', '월', '화', '수', '목', '금', '토'],
      axisLine: { show: false },
      axisTick: { show: false },
      splitArea: { show: false },
      axisLabel: { fontFamily: FONT_FAMILY, fontSize: 18 },
    },
    {
      gridIndex: 1,
      type: 'category',
      data: hourlyCategories,
      axisLabel: { fontFamily: FONT_FAMILY, fontSize: 14, interval: 1 },
    },
  ];

  const yAxes: Record<string, unknown>[] = [
    {
      gridIndex: 0,
      type: 'category',
      data: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
      axisLine: { show: false },
      axisTick: { show: false },
      splitArea: { show: false },
      axisLabel: { fontFamily: FONT_FAMILY, fontSize: 16 },
      inverse: true,
    },
    {
      gridIndex: 1,
      type: 'value',
      axisLabel: { fontFamily: FONT_FAMILY, fontSize: 14 },
    },
  ];

  const visualMap: Record<string, unknown>[] = [
    {
      show: false,
      type: 'piecewise',
      pieces,
      seriesIndex: 0,
    },
  ];

  const series: Record<string, unknown>[] = [
    {
      id: 'heatmap',
      type: 'heatmap',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: heatmapData,
      label: { show: false },
      itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
    },
    {
      id: 'hourly',
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: stats.hourly,
      itemStyle: { color: HEATMAP_PALETTE[3] },
    },
  ];

  // Rankings & sessions as graphic text groups.
  const graphic: Record<string, unknown>[] = [];

  // KPI strip (top)
  kpiStrip.forEach((kpi, i) => {
    const x = 120 + i * ((CANVAS_WIDTH - 240) / kpiStrip.length);
    graphic.push({
      type: 'text',
      left: x,
      top: 180,
      style: {
        text: kpi.label,
        fontFamily: FONT_FAMILY,
        fontSize: 20,
        fill: '#666',
      },
    });
    graphic.push({
      type: 'text',
      left: x,
      top: 210,
      style: {
        text: kpi.value,
        fontFamily: FONT_FAMILY,
        fontSize: 34,
        fontWeight: 'bold',
        fill: '#111',
      },
    });
  });

  // Rankings header + rows (token top-5)
  const rankX = 120;
  const rankY = 1100;
  graphic.push({
    type: 'text',
    left: rankX,
    top: rankY,
    style: { text: '🏆 토큰 사용 TOP 5', fontFamily: FONT_FAMILY, fontSize: 24, fontWeight: 'bold', fill: '#111' },
  });
  stats.rankings.tokensTop.slice(0, 5).forEach((r, i) => {
    const y = rankY + 50 + i * 44;
    const isTarget = r.userId === stats.targetUserId;
    graphic.push({
      type: 'text',
      left: rankX,
      top: y,
      style: {
        text: `${r.rank}. ${r.userName || r.userId} — ${fmt(r.totalTokens)}`,
        fontFamily: FONT_FAMILY,
        fontSize: 20,
        fontWeight: isTarget ? 'bold' : 'normal',
        fill: isTarget ? '#216e39' : '#333',
      },
    });
  });

  // Cost top-5
  const costX = 860;
  graphic.push({
    type: 'text',
    left: costX,
    top: rankY,
    style: { text: '💰 비용 TOP 5', fontFamily: FONT_FAMILY, fontSize: 24, fontWeight: 'bold', fill: '#111' },
  });
  stats.rankings.costTop.slice(0, 5).forEach((r, i) => {
    const y = rankY + 50 + i * 44;
    const isTarget = r.userId === stats.targetUserId;
    graphic.push({
      type: 'text',
      left: costX,
      top: y,
      style: {
        text: `${r.rank}. ${r.userName || r.userId} — $${r.totalCost.toFixed(2)}`,
        fontFamily: FONT_FAMILY,
        fontSize: 20,
        fontWeight: isTarget ? 'bold' : 'normal',
        fill: isTarget ? '#216e39' : '#333',
      },
    });
  });

  // Session top-3 (tokens) + top-3 (span)
  const sessX = 120;
  const sessY = 1480;
  graphic.push({
    type: 'text',
    left: sessX,
    top: sessY,
    style: { text: '💬 세션 TOP 3 (토큰)', fontFamily: FONT_FAMILY, fontSize: 24, fontWeight: 'bold', fill: '#111' },
  });
  stats.sessions.tokenTop3.forEach((s, i) => {
    const y = sessY + 50 + i * 44;
    graphic.push({
      type: 'text',
      left: sessX,
      top: y,
      style: {
        text: `${i + 1}. ${s.sessionKey} — ${fmt(s.totalTokens)} tokens`,
        fontFamily: FONT_FAMILY,
        fontSize: 18,
        fill: '#333',
      },
    });
  });

  const spanX = 860;
  graphic.push({
    type: 'text',
    left: spanX,
    top: sessY,
    style: {
      text: '⏱ 세션 TOP 3 (활동기간)',
      fontFamily: FONT_FAMILY,
      fontSize: 24,
      fontWeight: 'bold',
      fill: '#111',
    },
  });
  stats.sessions.spanTop3.forEach((s, i) => {
    const y = sessY + 50 + i * 44;
    const mins = Math.round(s.durationMs / 60000);
    graphic.push({
      type: 'text',
      left: spanX,
      top: y,
      style: {
        text: `${i + 1}. ${s.sessionKey} — ${mins}분`,
        fontFamily: FONT_FAMILY,
        fontSize: 18,
        fill: '#333',
      },
    });
  });

  // Favorite model + fun-fact footer
  graphic.push({
    type: 'text',
    left: 120,
    top: 1860,
    style: {
      text: stats.favoriteModel
        ? `⭐ 즐겨 쓰는 모델: ${stats.favoriteModel.model} (${fmt(stats.favoriteModel.tokens)} tokens)`
        : '⭐ 즐겨 쓰는 모델: —',
      fontFamily: FONT_FAMILY,
      fontSize: 22,
      fill: '#333',
    },
  });
  graphic.push({
    type: 'text',
    left: 120,
    top: 1920,
    style: {
      text: funFact,
      fontFamily: FONT_FAMILY,
      fontSize: 24,
      fontWeight: 'bold',
      fill: '#216e39',
    },
  });
  graphic.push({
    type: 'text',
    left: 120,
    top: 2080,
    style: {
      text: 'soma-work · /usage card',
      fontFamily: FONT_FAMILY,
      fontSize: 16,
      fill: '#999',
    },
  });

  const titleArr: Record<string, unknown>[] = [
    {
      id: 'main-title',
      text: title,
      left: 120,
      top: 80,
      textStyle: { fontFamily: FONT_FAMILY, fontSize: 36, fontWeight: 'bold', color: '#111' },
    },
    {
      id: 'subtitle-heatmap',
      text: '최근 30일 일별 활동',
      left: 120,
      top: 280,
      textStyle: { fontFamily: FONT_FAMILY, fontSize: 20, color: '#555' },
    },
    {
      id: 'subtitle-hourly',
      text: '시간대별 토큰 사용량',
      left: 120,
      top: 740,
      textStyle: { fontFamily: FONT_FAMILY, fontSize: 20, color: '#555' },
    },
  ];

  return {
    backgroundColor: '#ffffff',
    textStyle: { fontFamily: FONT_FAMILY },
    title: titleArr,
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    visualMap,
    series,
    graphic,
  };
}
