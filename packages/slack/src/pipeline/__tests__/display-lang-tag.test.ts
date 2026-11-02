/**
 * #772 — the user's display language rides once, at the very bottom of the
 * first prompt of a conversation session, as `<display-lang>ko</display-lang>`.
 * The model must never echo it: a reply that ends with it is cleaned before
 * anyone sees it.
 */

import { appendDisplayLangTag, displayLangTag } from '@soma/slack/pipeline/display-lang-tag';
import { describe, expect, it } from 'vitest';

describe('displayLangTag', () => {
  it('is one tag with the language code', () => {
    expect(displayLangTag('ko')).toBe('<display-lang>ko</display-lang>');
    expect(displayLangTag('en')).toBe('<display-lang>en</display-lang>');
  });
});

describe('appendDisplayLangTag', () => {
  it('appends the tag at the very bottom of the prompt', () => {
    const prompt = appendDisplayLangTag('<speaker>Z</speaker>\n대시보드 고쳐줘\n\n<context>\n</context>', 'ko');
    expect(prompt.endsWith('\n\n<display-lang>ko</display-lang>')).toBe(true);
    expect(prompt.startsWith('<speaker>Z</speaker>')).toBe(true);
  });
});
