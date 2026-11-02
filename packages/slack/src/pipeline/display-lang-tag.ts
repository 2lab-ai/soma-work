/**
 * #772 — the user's display language, told to the model once: at the very
 * bottom of the first prompt of a conversation session
 * (`<display-lang>ko</display-lang>`). The system prompt (common.prompt) says
 * what the tag means; a resumed conversation already has it in its history.
 */

import type { DisplayLang } from '@soma/common/i18n';

export function displayLangTag(lang: DisplayLang): string {
  return `<display-lang>${lang}</display-lang>`;
}

/** The prompt with the tag at its very bottom. */
export function appendDisplayLangTag(prompt: string, lang: DisplayLang): string {
  return `${prompt}\n\n${displayLangTag(lang)}`;
}
