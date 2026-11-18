/**
 * `auth` infographic → PNG: the SVG from `infographic-svg.ts`, rendered by
 * resvg with the bundled Noto Sans KR (`metrics/usage-render/font.ts`).
 *
 * Errors are the usage card's typed ones (`FontLoadError`, `ResvgNativeError`);
 * the card catches them and shows its text version instead.
 */

import { KOREAN_FONT_FAMILY, loadKoreanFontPath } from '../../metrics/usage-render/font';
import { svgToPng } from '../../metrics/usage-render/svg-to-png';
import type { AccountReport, AuthInfographic } from './infographic-model';
import { buildAccountReportSvg, buildAuthSummarySvg } from './infographic-svg';

async function render(svg: string): Promise<Buffer> {
  const fontPath = await loadKoreanFontPath();
  return svgToPng(svg, { fontPath, defaultFontFamily: KOREAN_FONT_FAMILY });
}

export async function renderAuthSummaryPng(info: AuthInfographic): Promise<Buffer> {
  return render(buildAuthSummarySvg(info));
}

export async function renderAuthReportPng(report: AccountReport): Promise<Buffer> {
  return render(buildAccountReportSvg(report));
}
