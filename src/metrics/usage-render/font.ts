/**
 * Bundled Noto Sans KR for resvg renders (usage card, `auth` infographic).
 *
 * The TTF ships next to this module (`assets/`, copied to `dist/metrics/usage-render/assets`
 * by `npm run build`). The resolved path is cached once it passes a size check; a failed
 * check is not cached, so a later call can recover after the asset is restored.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FontLoadError } from './errors';

const FONT_PATH = path.join(__dirname, 'assets', 'NotoSansKR.ttf');
/** The family name resvg is told to use when an SVG names none. */
export const KOREAN_FONT_FAMILY = 'Noto Sans KR';
const MIN_FONT_BYTES = 1024 * 100; // 100KB

let fontPathPromise: Promise<string> | null = null;

export async function loadKoreanFontPath(): Promise<string> {
  if (fontPathPromise) return fontPathPromise;
  const resolvedPath = FONT_PATH;
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
