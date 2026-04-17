/**
 * SVG → PNG renderer for `/usage card`.
 * Trace: docs/usage-card/trace.md, Scenario 6
 *
 * Pipeline: ECharts SSR (null DOM, svg renderer) → SVG string → resvg native PNG.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildOption, CANVAS_HEIGHT, CANVAS_WIDTH } from './buildOption';
import { EchartsInitError, FontLoadError } from './errors';
import { svgToPng } from './svg-to-png';
import type { UsageCardStats } from './types';

// `__dirname` resolves to `dist/metrics/usage-render` at runtime (CJS target) — see tsconfig.
const FONT_PATH = path.join(__dirname, 'assets', 'NotoSansKR.ttf');

let fontPathPromise: Promise<string> | null = null;
let testFontPath: string | null = null;

/**
 * Override font path for tests (resets cached promise).
 */
export function __setFontPathForTests(p: string | null): void {
  fontPathPromise = null;
  testFontPath = p;
}

async function loadFontPath(): Promise<string> {
  if (fontPathPromise) return fontPathPromise;
  const resolvedPath = testFontPath || FONT_PATH;
  fontPathPromise = fs
    .access(resolvedPath)
    .then(() => resolvedPath)
    .catch((err) => {
      fontPathPromise = null;
      throw new FontLoadError(`Failed to load Noto Sans KR from ${resolvedPath}`, err);
    });
  return fontPathPromise;
}

/**
 * Render a usage-card PNG from aggregated stats.
 */
export async function renderUsageCard(stats: UsageCardStats): Promise<Buffer> {
  const fontPath = await loadFontPath();

  let svg: string;
  try {
    // Lazy-load ECharts to keep cold-start cost off the hot-path when not used.
    const echarts = await import('echarts');
    const chart = (echarts as any).init(null, null, {
      renderer: 'svg',
      ssr: true,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
    });
    chart.setOption(buildOption(stats));
    svg = chart.renderToSVGString();
    chart.dispose();
  } catch (err) {
    throw new EchartsInitError('ECharts SSR failed', err);
  }

  return svgToPng(svg, { fontPath, defaultFontFamily: 'Noto Sans KR' });
}
