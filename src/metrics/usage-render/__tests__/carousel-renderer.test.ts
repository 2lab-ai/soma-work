/**
 * RED tests for carousel renderer (v2).
 * Trace: docs/usage-card-dark/trace.md — Scenario 10.
 *
 * All tests use DI mocks — real echarts + resvg are NOT invoked here.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CarouselRendererOptions } from '../carousel-renderer';
import { renderCarousel } from '../carousel-renderer';
import { EchartsInitError, ResvgNativeError } from '../errors';
import type { CarouselStats, CarouselTabStats, EmptyTabStats, TabId } from '../types';

// ───────────────────── Helpers ────────────────────────────────────────

function fakeChart(renderSvg: () => string = () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>') {
  return {
    setOption: vi.fn(),
    renderToSVGString: renderSvg,
    dispose: vi.fn(),
  };
}

/**
 * Build a minimal PNG-shaped Buffer. Real PNG parsing needs only:
 *   bytes 0..7  = 89 50 4E 47 0D 0A 1A 0A  (magic)
 *   bytes 16..19 = width BE
 *   bytes 20..23 = height BE
 * We also optionally embed a "content hash byte" at offset 23 so the two
 * selection states produce byte-different outputs.
 */
function makePng(width: number, height: number, contentByte = 0): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt8(0x89, 0);
  buf.writeUInt8(0x50, 1);
  buf.writeUInt8(0x4e, 2);
  buf.writeUInt8(0x47, 3);
  buf.writeUInt8(0x0d, 4);
  buf.writeUInt8(0x0a, 5);
  buf.writeUInt8(0x1a, 6);
  buf.writeUInt8(0x0a, 7);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height & 0xffffff00, 20);
  buf.writeUInt8((height & 0xff) ^ contentByte, 23);
  return buf;
}

function hashByte(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xff;
  return h;
}

// ───────────────────── Fixtures ───────────────────────────────────────

function makeTabStats(tabId: Exclude<TabId, 'models'>): CarouselTabStats {
  return {
    empty: false,
    tabId,
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    windowStart: '2026-03-20',
    windowEnd: '2026-04-18',
    totals: { tokens: 12345, costUsd: 0.42, sessions: 3 },
    favoriteModel: { model: 'claude-opus', tokens: 10000 },
    hourly: Array.from({ length: 24 }, (_, h) => h * 10),
    heatmap: [{ date: '2026-04-10', tokens: 500, cellIndex: 0 }],
    rankings: {
      tokensTop: [{ userId: 'U_TEST', userName: 'Tester', totalTokens: 12345, rank: 1 }],
      targetTokenRow: null,
    },
    activeDays: 5,
    longestStreakDays: 3,
    currentStreakDays: 2,
    topSessions: [],
    longestSession: null,
    mostActiveDay: null,
  };
}

function makeModelsTab(): import('../types').ModelsTabStats {
  return {
    empty: false,
    tabId: 'models',
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    windowStart: '2026-03-20',
    windowEnd: '2026-04-18',
    totalTokens: 12345,
    rows: [
      {
        model: 'claude-opus',
        inputTokens: 5000,
        outputTokens: 6000,
        cacheReadTokens: 1000,
        cacheCreateTokens: 345,
        totalTokens: 12345,
      },
    ],
    dayKeys: Array.from({ length: 30 }, (_, i) => `2026-03-${String(20 + (i % 11)).padStart(2, '0')}`),
    dailyByModel: { 'claude-opus': new Array(30).fill(0).map((_, i) => (i === 0 ? 12345 : 0)) },
  };
}

function makeCarouselStats(
  overrides: Partial<{
    '24h': CarouselTabStats | EmptyTabStats;
    '7d': CarouselTabStats | EmptyTabStats;
    '30d': CarouselTabStats | EmptyTabStats;
    all: CarouselTabStats | EmptyTabStats;
    models: import('../types').ModelsTabStats | EmptyTabStats;
  }> = {},
): CarouselStats {
  return {
    targetUserId: 'U_TEST',
    targetUserName: 'Tester',
    now: '2026-04-18T12:00:00+09:00',
    tabs: {
      '24h': overrides['24h'] ?? makeTabStats('24h'),
      '7d': overrides['7d'] ?? makeTabStats('7d'),
      '30d': overrides['30d'] ?? makeTabStats('30d'),
      all: overrides.all ?? makeTabStats('all'),
      models: overrides.models ?? makeModelsTab(),
    },
  };
}

type BuildOptionMock = NonNullable<CarouselRendererOptions['buildOption']>;
type InitChartMock = NonNullable<CarouselRendererOptions['initChart']>;
type SvgToPngMock = NonNullable<CarouselRendererOptions['svgToPng']>;

// DI factory: build consistent mocks per test.
function mocks(overrides: { buildOption?: BuildOptionMock; initChart?: InitChartMock; svgToPng?: SvgToPngMock } = {}) {
  const charts: Array<ReturnType<typeof fakeChart>> = [];
  const defaultBuildOption: BuildOptionMock = vi.fn((_stats: CarouselStats, tabId: TabId, selected: boolean) => ({
    tabId,
    selected,
  })) as unknown as BuildOptionMock;
  const buildOption: BuildOptionMock = overrides.buildOption ?? defaultBuildOption;

  const defaultInitChart: InitChartMock = vi.fn((_w: number, _h: number) => {
    const c = fakeChart(() => {
      // Embed last-set option into the SVG string so svgToPng hashing differs.
      const lastCall = c.setOption.mock.calls[c.setOption.mock.calls.length - 1];
      const opt = lastCall?.[0] ?? {};
      return `<svg>${JSON.stringify(opt)}</svg>`;
    });
    charts.push(c);
    return c;
  }) as unknown as InitChartMock;
  const initChart: InitChartMock = overrides.initChart ?? defaultInitChart;

  const defaultSvgToPng: SvgToPngMock = vi.fn(async (svg: string) =>
    makePng(1600, 2200, hashByte(svg)),
  ) as unknown as SvgToPngMock;
  const svgToPng: SvgToPngMock = overrides.svgToPng ?? defaultSvgToPng;

  return { buildOption, initChart, svgToPng, charts };
}

// ───────────────────── Cases ──────────────────────────────────────────

describe('renderCarousel', () => {
  it('happy path → returns 5 PNGs keyed by TabId, each 1600×2200', async () => {
    const { buildOption, initChart, svgToPng } = mocks();
    const stats = makeCarouselStats();

    const result = await renderCarousel(stats, '30d', { buildOption, initChart, svgToPng });

    expect(Object.keys(result).sort()).toEqual(['24h', '30d', '7d', 'all', 'models']);
    for (const tabId of ['24h', '7d', '30d', 'all', 'models'] as TabId[]) {
      const png = result[tabId];
      expect(Buffer.isBuffer(png)).toBe(true);
      // PNG magic
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png[2]).toBe(0x4e);
      expect(png[3]).toBe(0x47);
      // IHDR width/height
      expect(png.readUInt32BE(16)).toBe(1600);
      // height upper 3 bytes = 2200 & 0xffffff00 (we xor-embed content byte into lowest byte)
      const widthHiBytes = png.readUInt32BE(20) & 0xffffff00;
      expect(widthHiBytes).toBe(2200 & 0xffffff00);
    }
  });

  it('initChart called 5 times (parallel — 4 period tabs + models)', async () => {
    const { buildOption, initChart, svgToPng } = mocks();
    await renderCarousel(makeCarouselStats(), '30d', { buildOption, initChart, svgToPng });
    expect(initChart).toHaveBeenCalledTimes(5);
    expect(initChart).toHaveBeenCalledWith(1600, 2200);
  });

  it('buildOption receives selected=true once and false four times', async () => {
    const { buildOption, initChart, svgToPng } = mocks();
    await renderCarousel(makeCarouselStats(), '7d', { buildOption, initChart, svgToPng });

    const calls = (buildOption as unknown as { mock: { calls: Array<[CarouselStats, TabId, boolean]> } }).mock.calls;
    expect(calls).toHaveLength(5);
    const selectedCalls = calls.filter((c) => c[2] === true);
    const unselectedCalls = calls.filter((c) => c[2] === false);
    expect(selectedCalls).toHaveLength(1);
    expect(unselectedCalls).toHaveLength(4);
    expect(selectedCalls[0][1]).toBe('7d');
  });

  it('selected tab baked into PNG → byte-diff between different selectedTab runs', async () => {
    const stats = makeCarouselStats();
    const run = async (selected: TabId) => {
      const m = mocks();
      return renderCarousel(stats, selected, {
        buildOption: m.buildOption,
        initChart: m.initChart,
        svgToPng: m.svgToPng,
      });
    };

    const a = await run('30d');
    const b = await run('7d');
    // For tab '24h': selected flag differs? Actually for both runs it's false, so same.
    // For tab '30d': run-a selected=true, run-b selected=false → must differ.
    expect(Buffer.compare(a['30d'], b['30d'])).not.toBe(0);
    // For tab '7d': run-a selected=false, run-b selected=true → must differ.
    expect(Buffer.compare(a['7d'], b['7d'])).not.toBe(0);
  });

  it('error mapping: initChart throws → EchartsInitError', async () => {
    const { buildOption, svgToPng } = mocks();
    const initChart: InitChartMock = vi.fn(() => {
      throw new Error('init boom');
    }) as unknown as InitChartMock;
    await expect(
      renderCarousel(makeCarouselStats(), '30d', { buildOption, initChart, svgToPng }),
    ).rejects.toBeInstanceOf(EchartsInitError);
  });

  it('error mapping: svgToPng throws → ResvgNativeError', async () => {
    const { buildOption, initChart } = mocks();
    const svgToPng: SvgToPngMock = vi.fn(async () => {
      throw new Error('resvg crash');
    }) as unknown as SvgToPngMock;
    await expect(
      renderCarousel(makeCarouselStats(), '30d', { buildOption, initChart, svgToPng }),
    ).rejects.toBeInstanceOf(ResvgNativeError);
  });

  it('empty tab → still rendered via buildOption (not short-circuited)', async () => {
    const emptyTab: EmptyTabStats = {
      empty: true,
      tabId: '24h',
      windowStart: '2026-04-17',
      windowEnd: '2026-04-18',
    };
    const { buildOption, initChart, svgToPng } = mocks();
    const stats = makeCarouselStats({ '24h': emptyTab });

    const result = await renderCarousel(stats, '30d', { buildOption, initChart, svgToPng });

    // Renderer does NOT skip empty tabs — option builder decides stub.
    expect(buildOption).toHaveBeenCalledTimes(5);
    expect(initChart).toHaveBeenCalledTimes(5);
    expect(Object.keys(result)).toHaveLength(5);
    expect(result['24h']).toBeDefined();
    // Confirm buildOption saw the full stats + '24h' tabId
    const buildMock = buildOption as unknown as { mock: { calls: unknown[][] } };
    const tabIdCalls = buildMock.mock.calls.map((c) => c[1]);
    expect(tabIdCalls).toContain('24h');
  });

  it('dispose called exactly once per chart (5 total: 4 period + models)', async () => {
    const { buildOption, initChart, svgToPng, charts } = mocks();
    await renderCarousel(makeCarouselStats(), '30d', { buildOption, initChart, svgToPng });
    expect(charts).toHaveLength(5);
    for (const c of charts) {
      expect(c.dispose).toHaveBeenCalledTimes(1);
    }
  });
});
