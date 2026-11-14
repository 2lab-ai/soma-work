/**
 * Fold the name Chromium reports for a variable-font instance back to the family that loaded.
 *
 * Google Fonts serves a family such as "Noto Sans KR" as one variable file whose default instance is named
 * "Noto Sans KR Thin"; CSS.getPlatformFontsForNode reports that instance name, so a literal comparison claimed a
 * fallback that did not happen (research-skill run 2026-11-13, five of six html runs). Only a name whose family
 * actually loaded is folded — a face that never loaded stays visible as the fallback it is.
 *
 * @param {string[] | null} used   families Chromium drew with (null = probe failed)
 * @param {string[] | null} loaded families document.fonts reports as loaded (null = unknown)
 * @returns {string[] | null}
 */
const WEIGHT = /\s+(Hairline|Thin|ExtraLight|Extra Light|UltraLight|Light|Regular|Book|Medium|SemiBold|Semi Bold|DemiBold|Bold|ExtraBold|Extra Bold|UltraBold|Black|Heavy)$/i;

export function foldUsedFonts(used, loaded) {
  if (used === null) return null;
  const have = new Set(loaded ?? []);
  const out = new Set();
  for (const name of used) {
    const base = name.replace(WEIGHT, '');
    out.add(base !== name && have.has(base) ? base : name);
  }
  return [...out].sort();
}
