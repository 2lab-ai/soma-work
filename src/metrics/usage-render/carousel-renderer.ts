/**
 * Carousel renderer — produces 4 tab PNGs in parallel.
 * Trace: docs/usage-card-dark/trace.md — Scenario 10.
 *
 * Delegates the ECharts option shape to `buildCarouselOption.buildCardOption`
 * and reuses the shared `svg-to-png` + font cache. Each tab is rendered
 * independently in parallel via `Promise.all`; if one tab fails the first
 * error propagates wrapped as a `SafeOperationalError` subclass so
 * `isSafeOperational` still matches in the handler's catch.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EchartsInitError, FontLoadError, ResvgNativeError } from './errors';
import { svgToPng as defaultSvgToPng } from './svg-to-png';
import type { CarouselStats, TabId } from './types';

// ─── Defaults ──────────────────────────────────────────────────────────

/** Tab render order — matches button order in carousel. */
const TAB_IDS: TabId[] = ['24h', '7d', '30d', 'all'];

/** Canvas size per tab PNG. */
const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 2200;

// Module-level font cache.
const FONT_PATH = path.join(__dirname, 'assets', 'NotoSansKR.ttf');
let fontPathPromise: Promise<string> | null = null;
let testFontPath: string | null = null;
const MIN_FONT_BYTES = 1024 * 100; // 100KB

/** Test-only: override font path (resets cache). */
export function __setCarouselFontPathForTests(p: string | null): void {
  fontPathPromise = null;
  testFontPath = p;
}

async function loadFontPath(): Promise<string> {
  if (fontPathPromise) return fontPathPromise;
  const resolvedPath = testFontPath || FONT_PATH;
  fontPathPromise = (async () => {
    try {
      await fs.access(resolvedPath, fs.constants.R_OK);
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) throw new Error(`${resolvedPath} is not a regular file`);
      if (stat.size < MIN_FONT_BYTES) {
        throw new Error(`font at ${resolvedPath} is only ${stat.size} bytes (< ${MIN_FONT_BYTES})`);
      }
      return resolvedPath;
    } catch (err) {
      fontPathPromise = null;
      throw new FontLoadError(`Failed to load Noto Sans KR from ${resolvedPath}`, err);
    }
  })();
  return fontPathPromise;
}

// ─── Default DI impls (lazy — avoid loading heavy deps at module eval) ──

type ChartHandle = {
  setOption: (opt: unknown) => void;
  renderToSVGString: () => string;
  dispose?: () => void;
};

type BuildOptionFn = (carousel: CarouselStats, tabId: TabId, selected: boolean) => Record<string, unknown>;

type InitChartFn = (width: number, height: number) => ChartHandle;
type SvgToPngFn = (svg: string) => Promise<Buffer>;

/**
 * Lazy-load `buildCardOption` from sibling module. Kept lazy because
 * `buildCarouselOption.ts` is implemented in parallel and may not be present
 * at import-resolution time for this file's callers that only need DI mocks.
 */
async function loadDefaultBuildOption(): Promise<BuildOptionFn> {
  const mod = (await import('./buildCarouselOption')) as {
    buildCardOption: BuildOptionFn;
  };
  return mod.buildCardOption;
}

async function defaultInitChart(width: number, height: number): Promise<ChartHandle> {
  const echarts = (await import('echarts')) as unknown as {
    init: (dom: null, theme: null, opts: { renderer: 'svg'; ssr: true; width: number; height: number }) => ChartHandle;
  };
  return echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
}

// ─── Public API ────────────────────────────────────────────────────────

export interface CarouselRendererOptions {
  /** DI override for option builder — defaults to buildCardOption from ./buildCarouselOption */
  buildOption?: BuildOptionFn;
  /** Override for ECharts SSR init (for testing without loading echarts) */
  initChart?: InitChartFn;
  /** Override for resvg SVG→PNG conversion */
  svgToPng?: SvgToPngFn;
}

/**
 * Render all 4 tab PNGs for a carousel. The selected tab's PNG bakes in the
 * period-tab strip highlight (selection state is passed through `buildOption`).
 *
 * Error surface (all typed `SafeOperationalError` subclasses so
 * `isSafeOperational` matches in handler catch):
 *  - `FontLoadError`       — font asset missing / truncated
 *  - `EchartsInitError`    — echarts init/setOption/renderToSVGString threw
 *  - `ResvgNativeError`    — resvg conversion threw
 *
 * Decision: uses `Promise.all` (NOT `allSettled`). First error propagates —
 * handler surfaces a single typed failure rather than muddling 4 partial
 * results. Individual chart.dispose() calls on the failing tab may be skipped
 * by design (error path); GC reclaims the handle.
 */
export async function renderCarousel(
  carousel: CarouselStats,
  selectedTab: TabId,
  opts: CarouselRendererOptions = {},
): Promise<Record<TabId, Buffer>> {
  // Resolve DI (fall back to lazy-loaded real implementations).
  const buildOption: BuildOptionFn = opts.buildOption ?? (await loadDefaultBuildOption());

  // Real (non-DI) path needs async echarts init, so we branch at call time on
  // whether a sync DI override was supplied. Font load gated once when using
  // the real resvg path.
  const useRealInit = !opts.initChart;
  const initChart: InitChartFn | null = opts.initChart ?? null;
  const useRealSvgToPng = !opts.svgToPng;
  let fontPath: string | null = null;
  if (useRealSvgToPng) {
    fontPath = await loadFontPath();
  }
  const svgToPng: SvgToPngFn =
    opts.svgToPng ??
    ((svg: string) =>
      defaultSvgToPng(svg, {
        fontPath: fontPath as string,
        defaultFontFamily: 'Noto Sans KR',
      }));

  // Render one tab. Error wrapping enforced here so a single failure maps to
  // the correct typed subclass.
  async function renderOne(tabId: TabId): Promise<[TabId, Buffer]> {
    const selected = tabId === selectedTab;
    const option = buildOption(carousel, tabId, selected);

    let svg: string;
    let chart: ChartHandle | null = null;
    try {
      chart = useRealInit
        ? await defaultInitChart(CANVAS_WIDTH, CANVAS_HEIGHT)
        : (initChart as InitChartFn)(CANVAS_WIDTH, CANVAS_HEIGHT);
      chart.setOption(option);
      svg = chart.renderToSVGString();
    } catch (err) {
      throw new EchartsInitError(`ECharts SSR failed for tab ${tabId}`, err);
    } finally {
      // Dispose ran even if renderToSVGString threw — prevents handle leak.
      try {
        chart?.dispose?.();
      } catch {
        /* ignore dispose errors */
      }
    }

    let png: Buffer;
    try {
      png = await svgToPng(svg);
    } catch (err) {
      // svg-to-png's own wrapping already maps native errors to ResvgNativeError.
      // Preserve that subclass if present; otherwise wrap fresh.
      if (err instanceof ResvgNativeError || err instanceof FontLoadError) throw err;
      throw new ResvgNativeError(`resvg PNG render failed for tab ${tabId}`, err);
    }
    return [tabId, png];
  }

  const entries = await Promise.all(TAB_IDS.map(renderOne));
  // Build Record<TabId, Buffer> — keys are fixed so direct construction is fine.
  const out = {} as Record<TabId, Buffer>;
  for (const [tabId, png] of entries) {
    out[tabId] = png;
  }
  return out;
}
