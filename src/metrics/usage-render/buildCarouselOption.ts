/**
 * ECharts option builder for `/usage card` v2 — per-tab carousel.
 * Trace: docs/usage-card-dark/trace.md — Scenario 3.
 *
 * Pure, deterministic. Returns option shape only — NOT SVG — so tests can
 * assert on object values instead of string-matching rendered DOM.
 */

import { DARK_PALETTE, HEATMAP_SCALE } from './dark-palette';
import { pickFunFact } from './fun-facts';
import type { CarouselStats, CarouselTabStats, TabId, TabResult } from './types';

/**
 * Loose typing intentionally — we avoid a hard dep on ECharts types for
 * testability. The renderer passes this object into `chart.setOption(...)`
 * as-is, and ECharts accepts unknown keys gracefully.
 */
export type EChartsOptionLike = Record<string, unknown>;

export const CANVAS_WIDTH = 1600;
export const CANVAS_HEIGHT = 2200;

const FONT_FAMILY = 'Noto Sans KR';

const TAB_LABEL: Record<TabId, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All time',
};

const EMPTY_MESSAGE: Record<TabId, string> = {
  '24h': '최근 24시간 활동 없음',
  '7d': '최근 7일 활동 없음',
  '30d': '최근 30일 활동 없음',
  all: '전체 기간 활동 없음',
};

// ─── Helpers ───────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

function durationLabel(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}분`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}시간` : `${hours}시간 ${rem}분`;
}

/**
 * 5-step piecewise mapping from token count buckets to HEATMAP_SCALE.
 *
 * Strategy: upper bound = `Math.max(1, ...cell.tokens)` (spec §simplicity),
 * divided into 4 quartiles above zero + a dedicated zero bucket.
 */
function buildHeatmapPieces(cells: CarouselTabStats['heatmap']): Array<{
  min: number;
  max?: number;
  color: string;
}> {
  const maxTokens = cells.reduce((acc, c) => (c.tokens > acc ? c.tokens : acc), 0);
  const upper = Math.max(1, maxTokens);
  const q1 = Math.max(1, Math.floor(upper / 4));
  const q2 = Math.max(q1 + 1, Math.floor(upper / 2));
  const q3 = Math.max(q2 + 1, Math.floor((upper * 3) / 4));
  const q4 = Math.max(q3 + 1, upper);
  return [
    { min: 0, max: 0, color: HEATMAP_SCALE[0] },
    { min: 1, max: q1, color: HEATMAP_SCALE[1] },
    { min: q1 + 1, max: q2, color: HEATMAP_SCALE[2] },
    { min: q2 + 1, max: q3, color: HEATMAP_SCALE[3] },
    { min: q3 + 1, max: q4, color: HEATMAP_SCALE[4] },
  ];
}

function heatmapTuples(tabId: TabId, cells: CarouselTabStats['heatmap']): Array<[number, number, number]> {
  return cells.map((c) => {
    const i = c.cellIndex;
    switch (tabId) {
      case '7d': {
        // cellIndex = dayIdx * 24 + hour → xIndex = hour (0..23), yIndex = dayIdx (0..6)
        return [i % 24, Math.floor(i / 24), c.tokens] as [number, number, number];
      }
      case '30d': {
        // cellIndex = dayIdx (0..29, linear from windowStart) → (col, row) in 5×7 grid.
        // col = day-within-week-chunk (0..6), row = chunk index (0..4). NOT weekday.
        return [i % 7, Math.floor(i / 7), c.tokens] as [number, number, number];
      }
      case 'all': {
        // cellIndex = monthIdx * 7 + weekday → xIndex = monthIdx (0..11), yIndex = weekday (0..6)
        return [Math.floor(i / 7), i % 7, c.tokens] as [number, number, number];
      }
      default:
        return [i, 0, c.tokens] as [number, number, number];
    }
  });
}

/**
 * Shift a KST 'YYYY-MM-DD' day key by N days. Duplicated from report-aggregator
 * to keep buildCarouselOption self-contained (no runtime dep on aggregator).
 * KST has no DST so UTC arithmetic is safe.
 */
function shiftDayKey(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split('-').map((s) => parseInt(s, 10));
  const t = Date.UTC(y, m - 1, d) + delta * 86_400_000;
  const nd = new Date(t);
  const yy = nd.getUTCFullYear();
  const mm = nd.getUTCMonth() + 1;
  const dd = nd.getUTCDate();
  return `${yy.toString().padStart(4, '0')}-${mm.toString().padStart(2, '0')}-${dd.toString().padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → 'MM/DD' short label for axis display. */
function shortDateLabel(dayKey: string): string {
  const [, mm, dd] = dayKey.split('-');
  return `${mm}/${dd}`;
}

// ─── Axis builders ─────────────────────────────────────────────────────

function axisStyle() {
  return {
    axisLine: { lineStyle: { color: DARK_PALETTE.grid } },
    axisTick: { lineStyle: { color: DARK_PALETTE.grid } },
    axisLabel: { color: DARK_PALETTE.textMuted, fontFamily: FONT_FAMILY, fontSize: 14 },
    splitLine: { lineStyle: { color: DARK_PALETTE.grid } },
    splitArea: { show: false },
  };
}

// ─── Option builders per tab ───────────────────────────────────────────

function build24hOption(stats: CarouselTabStats, selected: boolean): EChartsOptionLike {
  const hourlyCategories = Array.from({ length: 24 }, (_, h) => `${h}`);
  const barColor = selected ? DARK_PALETTE.accent : DARK_PALETTE.accentSoft;

  return {
    backgroundColor: DARK_PALETTE.bg,
    textStyle: { fontFamily: FONT_FAMILY, color: DARK_PALETTE.text },
    grid: { left: 80, right: 80, top: 60, bottom: 60, containLabel: true },
    xAxis: {
      type: 'category',
      data: hourlyCategories,
      ...axisStyle(),
    },
    yAxis: {
      type: 'value',
      ...axisStyle(),
    },
    series: [
      {
        id: 'hourly-24h',
        type: 'bar',
        data: stats.hourly.slice(0, 24),
        itemStyle: { color: barColor },
      },
    ],
  };
}

function buildHeatmapOption(
  tabId: '7d' | '30d' | 'all',
  stats: CarouselTabStats,
  _selected: boolean,
): EChartsOptionLike {
  const data = heatmapTuples(tabId, stats.heatmap);
  const pieces = buildHeatmapPieces(stats.heatmap);

  let xAxisData: string[];
  let yAxisData: string[];
  if (tabId === '7d') {
    // Row = dayIdx (linear from windowStart, NOT weekday). Label with real MM/DD
    // per-row so the axis cannot be read as weekday.
    xAxisData = Array.from({ length: 24 }, (_, h) => `${h}`);
    yAxisData = Array.from({ length: 7 }, (_, d) => shortDateLabel(shiftDayKey(stats.windowStart, d)));
  } else if (tabId === '30d') {
    // Column = day-within-chunk (1..7, NOT weekday — bounds.start defines the first column).
    // Row = weekly chunk index. 5 rows × 7 cols = 35 cells; first row starts at windowStart,
    // second row at windowStart+7, etc.
    xAxisData = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];
    yAxisData = Array.from({ length: 5 }, (_, w) => shortDateLabel(shiftDayKey(stats.windowStart, w * 7)));
  } else {
    xAxisData = Array.from({ length: 12 }, (_, m) => `${m + 1}월`);
    yAxisData = ['일', '월', '화', '수', '목', '금', '토'];
  }

  return {
    backgroundColor: DARK_PALETTE.bg,
    textStyle: { fontFamily: FONT_FAMILY, color: DARK_PALETTE.text },
    grid: { left: 80, right: 80, top: 60, bottom: 60, containLabel: true },
    xAxis: {
      type: 'category',
      data: xAxisData,
      ...axisStyle(),
    },
    yAxis: {
      type: 'category',
      data: yAxisData,
      ...axisStyle(),
      inverse: tabId !== 'all',
    },
    visualMap: {
      type: 'piecewise',
      pieces,
      show: false,
      seriesIndex: 0,
    },
    series: [
      {
        id: `heatmap-${tabId}`,
        type: 'heatmap',
        data,
        label: { show: false },
        itemStyle: { borderColor: DARK_PALETTE.bg, borderWidth: 2 },
      },
    ],
  };
}

// ─── Public: buildStubOption ───────────────────────────────────────────

export function buildStubOption(tabId: TabId): EChartsOptionLike {
  const message = EMPTY_MESSAGE[tabId];
  return {
    backgroundColor: DARK_PALETTE.bg,
    textStyle: { fontFamily: FONT_FAMILY, color: DARK_PALETTE.text },
    title: {
      id: 'stub-title',
      text: message,
      left: 'center',
      top: 'middle',
      textStyle: {
        color: DARK_PALETTE.textMuted,
        fontFamily: FONT_FAMILY,
        fontSize: 32,
        fontWeight: 'normal',
      },
    },
    graphic: [
      {
        id: 'stub-message',
        type: 'text',
        left: 'center',
        top: 'middle',
        style: {
          text: message,
          fill: DARK_PALETTE.textMuted,
          fontFamily: FONT_FAMILY,
          fontSize: 32,
        },
      },
    ],
    series: [],
  };
}

// ─── Public: buildTabOption ────────────────────────────────────────────

export function buildTabOption(tabId: TabId, stats: TabResult, selected: boolean): EChartsOptionLike {
  if (stats.empty) {
    return buildStubOption(tabId);
  }
  if (tabId === '24h') return build24hOption(stats, selected);
  return buildHeatmapOption(tabId, stats, selected);
}

// ─── Public: buildCardOption ───────────────────────────────────────────

/**
 * Full-card ECharts option for one selected tab — header + subtabs + period
 * strip + main chart (from `buildTabOption`) + metric grid + fun fact + rank
 * row. Layout follows Spec §4.3 (1600×2200).
 *
 * The period-tab pills are emitted as graphic rects tagged with
 * `periodTab: true` and `periodTabId: TabId` so tests and downstream tooling
 * can index into them without string-scanning.
 */
export function buildCardOption(carousel: CarouselStats, tabId: TabId, selected: boolean): EChartsOptionLike {
  const tabStats = carousel.tabs[tabId];
  const base = buildTabOption(tabId, tabStats, selected) as Record<string, unknown>;

  const now = carousel.now;
  const userLabel = carousel.targetUserName || carousel.targetUserId;
  const headerRight = `@${userLabel} · ${now.slice(0, 10)}`;

  const title: Array<Record<string, unknown>> = [
    {
      id: 'card-header-left',
      text: '📊 /usage card',
      left: 80,
      top: 60,
      textStyle: {
        color: DARK_PALETTE.text,
        fontFamily: FONT_FAMILY,
        fontSize: 36,
        fontWeight: 'bold',
      },
    },
    {
      id: 'card-header-right',
      text: headerRight,
      right: 80,
      top: 72,
      textStyle: {
        color: DARK_PALETTE.textMuted,
        fontFamily: FONT_FAMILY,
        fontSize: 22,
      },
    },
  ];

  const graphic: Array<Record<string, unknown>> = [];

  // Subtab row (Overview active, Models muted — static in v2).
  graphic.push(
    {
      id: 'subtab-overview',
      type: 'text',
      left: 80,
      top: 140,
      style: {
        text: 'Overview',
        fill: DARK_PALETTE.text,
        fontFamily: FONT_FAMILY,
        fontSize: 22,
        fontWeight: 'bold',
      },
    },
    {
      id: 'subtab-models',
      type: 'text',
      left: 220,
      top: 140,
      style: {
        text: 'Models',
        fill: DARK_PALETTE.textMuted,
        fontFamily: FONT_FAMILY,
        fontSize: 22,
      },
    },
  );

  // Period-tab pills — 4 rects, selected uses accent, others surface.
  const tabOrder: TabId[] = ['24h', '7d', '30d', 'all'];
  const pillW = 200;
  const pillH = 60;
  const pillGap = 16;
  const pillY = 200;
  tabOrder.forEach((id, idx) => {
    const isSelected = selected && id === tabId;
    const fill = isSelected ? DARK_PALETTE.accent : DARK_PALETTE.surface;
    const textFill = isSelected ? DARK_PALETTE.bg : DARK_PALETTE.text;
    const left = 80 + idx * (pillW + pillGap);
    graphic.push({
      id: `period-tab-${id}`,
      periodTab: true,
      periodTabId: id,
      type: 'rect',
      left,
      top: pillY,
      shape: { width: pillW, height: pillH, r: 8 },
      style: {
        fill,
        backgroundColor: fill,
        stroke: DARK_PALETTE.grid,
      },
      z: 2,
    });
    graphic.push({
      id: `period-tab-label-${id}`,
      type: 'text',
      left: left + pillW / 2 - 30,
      top: pillY + pillH / 2 - 12,
      style: {
        text: TAB_LABEL[id],
        fill: textFill,
        fontFamily: FONT_FAMILY,
        fontSize: 22,
        fontWeight: isSelected ? 'bold' : 'normal',
      },
      z: 3,
    });
  });

  // Metric grid — 8 cells (2 rows × 4 cols). Skip entirely for empty tab.
  if (!tabStats.empty) {
    const metrics: Array<{ label: string; value: string }> = [
      {
        label: 'Favorite model',
        value: tabStats.favoriteModel ? tabStats.favoriteModel.model : '—',
      },
      { label: 'Total tokens', value: fmt(tabStats.totals.tokens) },
      { label: 'Sessions', value: `${tabStats.totals.sessions}` },
      { label: 'Active days', value: `${tabStats.activeDays}` },
      {
        label: 'Most active day',
        value: tabStats.mostActiveDay ? tabStats.mostActiveDay.date : '—',
      },
      {
        label: 'Longest session',
        value: tabStats.longestSession ? durationLabel(tabStats.longestSession.durationMs) : '—',
      },
      { label: 'Longest streak', value: `${tabStats.longestStreakDays}일` },
      { label: 'Current streak', value: `${tabStats.currentStreakDays}일` },
    ];
    const metricY = 1500;
    const colW = 360;
    const rowH = 80;
    metrics.forEach((m, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = 80 + col * colW;
      const y = metricY + row * rowH;
      graphic.push({
        id: `metric-label-${i}`,
        type: 'text',
        left: x,
        top: y,
        style: {
          text: m.label,
          fill: DARK_PALETTE.textMuted,
          fontFamily: FONT_FAMILY,
          fontSize: 18,
        },
      });
      graphic.push({
        id: `metric-value-${i}`,
        type: 'text',
        left: x,
        top: y + 26,
        style: {
          text: m.value,
          fill: DARK_PALETTE.text,
          fontFamily: FONT_FAMILY,
          fontSize: 28,
          fontWeight: 'bold',
        },
      });
    });

    // Fun fact
    graphic.push({
      id: 'fun-fact',
      type: 'text',
      left: 80,
      top: 1780,
      style: {
        text: `💡 ${pickFunFact(tabStats.totals.tokens)}`,
        fill: DARK_PALETTE.accent,
        fontFamily: FONT_FAMILY,
        fontSize: 24,
        fontWeight: 'bold',
      },
    });

    // Ranking row
    const rank =
      tabStats.rankings.targetTokenRow ??
      tabStats.rankings.tokensTop.find((r) => r.userId === tabStats.targetUserId) ??
      null;
    const rankText = rank ? `Ranking — #${rank.rank} · ${fmt(rank.totalTokens)} tokens` : 'Ranking — —';
    graphic.push({
      id: 'ranking-row',
      type: 'text',
      left: 80,
      top: 1900,
      style: {
        text: rankText,
        fill: DARK_PALETTE.text,
        fontFamily: FONT_FAMILY,
        fontSize: 22,
      },
    });
  }

  // Merge stub graphics (e.g. "활동 없음") from the base option, if any.
  const baseGraphic = base.graphic;
  if (Array.isArray(baseGraphic)) {
    for (const g of baseGraphic) graphic.push(g as Record<string, unknown>);
  } else if (baseGraphic && typeof baseGraphic === 'object') {
    graphic.push(baseGraphic as Record<string, unknown>);
  }

  // Merge stub title text into card title, if base had one.
  const baseTitle = base.title;
  if (Array.isArray(baseTitle)) {
    for (const t of baseTitle) title.push(t as Record<string, unknown>);
  } else if (baseTitle && typeof baseTitle === 'object') {
    title.push(baseTitle as Record<string, unknown>);
  }

  return {
    ...base,
    backgroundColor: DARK_PALETTE.bg,
    textStyle: { fontFamily: FONT_FAMILY, color: DARK_PALETTE.text },
    title,
    graphic,
  };
}
