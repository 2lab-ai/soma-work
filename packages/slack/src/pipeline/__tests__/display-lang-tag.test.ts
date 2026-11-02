/**
 * #772 — the user's display language rides at the very bottom of the first
 * instruction of a session as `<display-lang>ko</display-lang>`, and again on
 * the first instruction after the user changes it. Every other turn carries
 * nothing (the model keeps the language it was told).
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
  it('appends the tag at the very bottom of the first instruction', () => {
    const r = appendDisplayLangTag('<speaker>Z</speaker>\n대시보드 고쳐줘\n\n<context>\n</context>', undefined, 'ko');
    expect(r.prompt.endsWith('\n\n<display-lang>ko</display-lang>')).toBe(true);
    expect(r.prompt.startsWith('<speaker>Z</speaker>')).toBe(true);
    expect(r.sent).toBe('ko');
  });

  it('adds nothing once the session was told this language', () => {
    const r = appendDisplayLangTag('두 번째 지시', 'ko', 'ko');
    expect(r).toEqual({ prompt: '두 번째 지시', sent: 'ko' });
  });

  it('tells the model again after the user switches language', () => {
    const r = appendDisplayLangTag('next', 'ko', 'en');
    expect(r.prompt).toBe('next\n\n<display-lang>en</display-lang>');
    expect(r.sent).toBe('en');
  });
});
