/**
 * SVG → PNG conversion via @resvg/resvg-js.
 * Trace: docs/usage-card/trace.md, Scenario 6 (step 5-6 of render pipeline).
 *
 * Kept in its own module so the native-bound resvg import is isolated
 * from the ECharts SSR path — tests and callers that only need the
 * chart option can skip loading the native binary.
 */

import { ResvgNativeError } from './errors';

export interface SvgToPngOptions {
  /** Absolute path to a TTF/OTF font file. */
  fontPath: string;
  /** Font-family name used by resvg as the default when SVG omits one. */
  defaultFontFamily: string;
}

/**
 * Convert an SVG string to a PNG Buffer.
 *
 * Wraps resvg failures into `ResvgNativeError` so the caller's whitelist
 * catch (`SafeOperationalError`) works uniformly. Any other error type
 * is allowed to bubble up untouched so silent failures never creep in.
 */
export async function svgToPng(svg: string, opts: SvgToPngOptions): Promise<Buffer> {
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'original' },
      font: {
        fontFiles: [opts.fontPath],
        defaultFontFamily: opts.defaultFontFamily,
        loadSystemFonts: false,
      },
    });
    return resvg.render().asPng();
  } catch (err) {
    throw new ResvgNativeError('resvg PNG render failed', err);
  }
}
