/**
 * #772 — the user's display language, told to the model at the very bottom
 * of the session's first instruction (`<display-lang>ko</display-lang>`), and
 * again on the first instruction after the user changes it. The system prompt
 * (common.prompt) says what the tag means; other turns carry nothing.
 */

import type { DisplayLang } from '@soma/common/i18n';

export function displayLangTag(lang: DisplayLang): string {
  return `<display-lang>${lang}</display-lang>`;
}

/**
 * The prompt with the tag appended when the session has not been told `lang`
 * yet (`sent` is what it was last told), and what it has been told after.
 */
export function appendDisplayLangTag(
  prompt: string,
  sent: DisplayLang | undefined,
  lang: DisplayLang,
): { prompt: string; sent: DisplayLang } {
  if (sent === lang) return { prompt, sent };
  return { prompt: `${prompt}\n\n${displayLangTag(lang)}`, sent: lang };
}
