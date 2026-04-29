/**
 * ECharts option builder for `/usage card` v2 — per-tab carousel.
 * Trace: docs/usage-card-dark/trace.md — Scenario 3.
 *
 * Pure, deterministic. Returns option shape only — NOT SVG — so tests can
 * assert on object values instead of string-matching rendered DOM.
 */

import { DARK_PALETTE, HEATMAP_SCALE } from './dark-palette';
import { pickFunFact } from './fun-facts';
import {
  type CarouselStats,
  type CarouselTabStats,
  type ModelsTabStats,
  type PeriodTabId,
  rowTotalTokens,
  type TabId,
  type TabResult,
} from './types';

/**
 * Loose typing intentionally — we avoid a hard dep on ECharts types for
 * testability. The renderer passes this object into `chart.setOption(...)`
 * as-is, and ECharts accepts unknown keys gracefully.
 */
export type EChartsOptionLike = Record<string, unknown>;

const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 2200;

const FONT_FAMILY = 'Noto Sans KR';

const TAB_LABEL: Record<TabId, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All time',
  models: 'Models',
};

const EMPTY_MESSAGE: Record<TabId, string> = {
  '24h': '최근 24시간 활동 없음',
  '7d': '최근 7일 활동 없음',
  '30d': '최근 30일 활동 없음',
  all: '전체 기간 활동 없음',
  models: '최근 30일 모델 활동 없음',
};

/**
 * 8-color palette for the Models tab stacked-bar series and breakdown rows.
 * Order matches the sort in `ModelsTabStats.rows` (totalTokens desc): the
 * largest model gets `MODEL_PALETTE[0]`, etc. Index 7 reuses the muted text
 * color so the 'other' fold row reads as low-emphasis.
 *
 * The endpoints reuse `DARK_PALETTE.accent` / `.textMuted` so a future
 * palette tweak propagates without drifting from the rest of the card.
 * Palette tuned against `DARK_PALETTE.bg` (#1A1A1A) for ≥ 4.5:1 contrast.
 */
export const MODEL_PALETTE: readonly string[] = [
  DARK_PALETTE.accent, // primary
  '#5C8FCD', // blue
  '#9C5CCD', // purple
  '#5CCD8F', // green
  '#CDB85C', // gold
  '#CD5C7F', // pink
  '#5CCDC9', // teal
  DARK_PALETTE.textMuted, // 'other' / tail
] as const;

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

function heatmapTuples(tabId: PeriodTabId, cells: CarouselTabStats['heatmap']): Array<[number, number, number]> {
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

/**
 * Build the Models tab option — stacked bar of per-day per-model tokens
 * (top of canvas) over the 30d window. The per-model breakdown rows
 * (model name, "{in} in · {out} out", "{pct}%") are NOT emitted here —
 * `buildCardOption` lays them out as `graphic` elements alongside the
 * subtab/period chrome so all model-related text shares the card's font
 * stack and palette.
 *
 * Color assignment: series order matches `stats.rows` order (totalTokens desc),
 * so series[i].color = MODEL_PALETTE[i mod len]. The 'other' fold row, when
 * present, lands on the desaturated tail color.
 */
function buildModelsTabOption(stats: ModelsTabStats, _selected: boolean): EChartsOptionLike {
  const xAxisData = stats.dayKeys.map(shortDateLabel);

  const series = stats.rows.map((row, i) => ({
    id: `models-bar-${row.model}`,
    name: row.model,
    type: 'bar',
    stack: 'modelsStack',
    data: stats.dailyByModel[row.model] ?? new Array<number>(stats.dayKeys.length).fill(0),
    itemStyle: { color: MODEL_PALETTE[i % MODEL_PALETTE.length] },
    // Bar stacks merge their borders so adjacent days look like one block at
    // small widths; explicit borderWidth:0 keeps the rendered stroke off.
    barCategoryGap: '20%',
  }));

  return {
    backgroundColor: DARK_PALETTE.bg,
    textStyle: { fontFamily: FONT_FAMILY, color: DARK_PALETTE.text },
    // Layout: chart occupies top half of canvas (top 320 .. ~1240), leaving
    // ~960px below for the breakdown table emitted by buildCardOption.
    grid: { left: 100, right: 80, top: 320, bottom: 1000, containLabel: true },
    xAxis: {
      type: 'category',
      data: xAxisData,
      ...axisStyle(),
      axisLabel: {
        color: DARK_PALETTE.textMuted,
        fontFamily: FONT_FAMILY,
        fontSize: 14,
        // 30 ticks at 1600px wide is dense — show every 4th label
        // (8 visible) so they don't collide.
        interval: 3,
      },
    },
    yAxis: {
      type: 'value',
      ...axisStyle(),
    },
    series,
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
  // Discriminate on the stats payload, not the `tabId` parameter — the
  // payload's `tabId` is the real type discriminator and lets TS narrow
  // without `as` casts.
  if (stats.tabId === 'models') return buildModelsTabOption(stats, selected);
  if (stats.tabId === '24h') return build24hOption(stats, selected);
  return buildHeatmapOption(stats.tabId, stats, selected);
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

  // Subtab row — Overview vs Models. The active subtab gets `text` + bold;
  // the inactive one gets `textMuted`. The labels are decorative (actual
  // navigation is via Block Kit buttons), but they double as a visual cue
  // that Models is now a real view, not a placeholder.
  const isModels = tabId === 'models';
  graphic.push(
    {
      id: 'subtab-overview',
      type: 'text',
      left: 80,
      top: 140,
      style: {
        text: 'Overview',
        fill: isModels ? DARK_PALETTE.textMuted : DARK_PALETTE.text,
        fontFamily: FONT_FAMILY,
        fontSize: 22,
        fontWeight: isModels ? 'normal' : 'bold',
      },
    },
    {
      id: 'subtab-models',
      type: 'text',
      left: 220,
      top: 140,
      style: {
        text: 'Models',
        fill: isModels ? DARK_PALETTE.text : DARK_PALETTE.textMuted,
        fontFamily: FONT_FAMILY,
        fontSize: 22,
        fontWeight: isModels ? 'bold' : 'normal',
      },
    },
  );

  // Period-tab pills — 4 rects (period tabs only, NOT including 'models').
  // Selected pill uses accent + bold; others use surface. When `tabId` is
  // 'models', no pill is highlighted (Models view doesn't sit on a period
  // axis — the view is fixed to 30d).
  const periodOrder: PeriodTabId[] = ['24h', '7d', '30d', 'all'];
  const pillW = 200;
  const pillH = 60;
  const pillGap = 16;
  const pillY = 200;
  periodOrder.forEach((id, idx) => {
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

  // Empty tabs short-circuit through the base option's stub graphic merge below.
  if (!tabStats.empty) {
    if (tabStats.tabId === 'models') {
      pushModelsBodyGraphics(graphic, tabStats);
    } else {
      pushPeriodBodyGraphics(graphic, tabStats);
    }
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

// ─── Body helpers (period vs models) ──────────────────────────────────

/**
 * Period-tab body: 8-cell metric grid (favorite model / total tokens / etc.)
 * + fun fact + ranking row.
 */
function pushPeriodBodyGraphics(graphic: Array<Record<string, unknown>>, periodStats: CarouselTabStats): void {
  const metrics: Array<{ label: string; value: string }> = [
    { label: 'Favorite model', value: periodStats.favoriteModel ? periodStats.favoriteModel.model : '—' },
    { label: 'Total tokens', value: fmt(periodStats.totals.tokens) },
    { label: 'Sessions', value: `${periodStats.totals.sessions}` },
    { label: 'Active days', value: `${periodStats.activeDays}` },
    { label: 'Most active day', value: periodStats.mostActiveDay ? periodStats.mostActiveDay.date : '—' },
    {
      label: 'Longest session',
      value: periodStats.longestSession ? durationLabel(periodStats.longestSession.durationMs) : '—',
    },
    { label: 'Longest streak', value: `${periodStats.longestStreakDays}일` },
    { label: 'Current streak', value: `${periodStats.currentStreakDays}일` },
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
      style: { text: m.label, fill: DARK_PALETTE.textMuted, fontFamily: FONT_FAMILY, fontSize: 18 },
    });
    graphic.push({
      id: `metric-value-${i}`,
      type: 'text',
      left: x,
      top: y + 26,
      style: { text: m.value, fill: DARK_PALETTE.text, fontFamily: FONT_FAMILY, fontSize: 28, fontWeight: 'bold' },
    });
  });

  graphic.push({
    id: 'fun-fact',
    type: 'text',
    left: 80,
    top: 1780,
    style: {
      text: `💡 ${pickFunFact(periodStats.totals.tokens)}`,
      fill: DARK_PALETTE.accent,
      fontFamily: FONT_FAMILY,
      fontSize: 24,
      fontWeight: 'bold',
    },
  });

  const rank =
    periodStats.rankings.targetTokenRow ??
    periodStats.rankings.tokensTop.find((r) => r.userId === periodStats.targetUserId) ??
    null;
  const rankText = rank ? `Ranking — #${rank.rank} · ${fmt(rank.totalTokens)} tokens` : 'Ranking — —';
  graphic.push({
    id: 'ranking-row',
    type: 'text',
    left: 80,
    top: 1900,
    style: { text: rankText, fill: DARK_PALETTE.text, fontFamily: FONT_FAMILY, fontSize: 22 },
  });
}

/**
 * Models-tab body: per-model breakdown rows under the stacked-bar chart.
 * Layout: rows start at y=1280 (just below the chart's `bottom:1000` gap area),
 * 8 rows × 90px = 720px tall, ending at y=2000.
 */
function pushModelsBodyGraphics(graphic: Array<Record<string, unknown>>, models: ModelsTabStats): void {
  const rowsY = 1280;
  const rowH = 90;
  const denom = Math.max(1, models.totalTokens);

  graphic.push({
    id: 'models-rows-header',
    type: 'text',
    left: 80,
    top: rowsY - 60,
    style: {
      text: `Token usage by model — Last 30d (총 ${fmt(models.totalTokens)} tokens)`,
      fill: DARK_PALETTE.text,
      fontFamily: FONT_FAMILY,
      fontSize: 24,
      fontWeight: 'bold',
    },
  });

  models.rows.forEach((row, i) => {
    const y = rowsY + i * rowH;
    const color = MODEL_PALETTE[i % MODEL_PALETTE.length];
    const total = rowTotalTokens(row);
    const pct = ((total / denom) * 100).toFixed(1);

    graphic.push({
      id: `models-row-swatch-${i}`,
      type: 'rect',
      left: 80,
      top: y + 12,
      shape: { width: 28, height: 28, r: 4 },
      style: { fill: color, backgroundColor: color, stroke: color },
      z: 2,
    });
    graphic.push({
      id: `models-row-name-${i}`,
      type: 'text',
      left: 130,
      top: y + 14,
      style: { text: row.model, fill: DARK_PALETTE.text, fontFamily: FONT_FAMILY, fontSize: 26, fontWeight: 'bold' },
    });
    graphic.push({
      id: `models-row-tokens-${i}`,
      type: 'text',
      left: 700,
      top: y + 18,
      style: {
        text: `${fmt(row.inputTokens)} in · ${fmt(row.outputTokens)} out`,
        fill: DARK_PALETTE.textMuted,
        fontFamily: FONT_FAMILY,
        fontSize: 22,
      },
    });
    graphic.push({
      id: `models-row-pct-${i}`,
      type: 'text',
      right: 80,
      top: y + 14,
      style: {
        text: `${pct}%`,
        fill: DARK_PALETTE.text,
        fontFamily: FONT_FAMILY,
        fontSize: 26,
        fontWeight: 'bold',
      },
    });
  });
}
