/**
 * research-skill run 2026-11-13: five of six html runs saw `fonts used: … Noto Sans KR Thin` for a page that
 * declared and loaded "Noto Sans KR". Google serves the family as one variable file whose default instance is
 * named "Thin", and Chromium reports that instance name. Read literally, html Step 6 then claims a font fallback
 * that did not happen. The renderer folds such a name back to the loaded family; a family that never loaded is
 * still reported as it is.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM helper next to render.mjs, no type declarations
import { foldUsedFonts } from '../renderer/font-names.mjs';

describe('fonts used — a variable font is reported under the family that loaded', () => {
  it('folds a weight-named instance of a loaded family back to the family', () => {
    expect(foldUsedFonts(['Inter', 'Noto Sans KR Thin'], ['Inter', 'Noto Sans KR'])).toEqual(['Inter', 'Noto Sans KR']);
    expect(foldUsedFonts(['Noto Sans JP ExtraLight', 'Menlo'], ['Noto Sans JP'])).toEqual(['Menlo', 'Noto Sans JP']);
  });

  it('keeps a real fallback visible: a family that did not load is not renamed', () => {
    expect(foldUsedFonts(['Helvetica Neue Thin'], ['Inter'])).toEqual(['Helvetica Neue Thin']);
    expect(foldUsedFonts(['Apple SD Gothic Neo'], ['Pretendard'])).toEqual(['Apple SD Gothic Neo']);
  });

  it('unknown stays unknown', () => {
    expect(foldUsedFonts(null, ['Inter'])).toBeNull();
    expect(foldUsedFonts(['Inter'], null)).toEqual(['Inter']);
  });
});
