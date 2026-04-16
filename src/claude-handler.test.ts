import { describe, expect, it } from 'vitest';
import { buildBetaHeaders, buildThinkingOption } from './claude-handler';
import { DEFAULT_SHOW_THINKING, DEFAULT_THINKING_ENABLED } from './user-settings-store';

describe('buildThinkingOption', () => {
  it('returns adaptive+summarized when thinkingEnabled=true and showSummary=true', () => {
    expect(buildThinkingOption(true, true)).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('returns adaptive+omitted when thinkingEnabled=true and showSummary=false', () => {
    expect(buildThinkingOption(true, false)).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('returns disabled when thinkingEnabled=false', () => {
    expect(buildThinkingOption(false, true)).toEqual({ type: 'disabled' });
    expect(buildThinkingOption(false, false)).toEqual({ type: 'disabled' });
  });

  it('defaults (thinkingEnabled=true, showSummary=true) yield adaptive+summarized', () => {
    // Validates the behaviour that the handler applies when no slackContext.user is
    // present: it falls back to DEFAULT_THINKING_ENABLED and DEFAULT_SHOW_THINKING.
    expect(DEFAULT_THINKING_ENABLED).toBe(true);
    expect(DEFAULT_SHOW_THINKING).toBe(true);
    expect(buildThinkingOption(DEFAULT_THINKING_ENABLED, DEFAULT_SHOW_THINKING)).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
  });
});

describe('buildBetaHeaders', () => {
  it('returns undefined when no API key', () => {
    expect(buildBetaHeaders('claude-sonnet-4-5-20250929', false)).toBeUndefined();
  });

  it('omits 1M beta for Opus 4.7 (1M GA)', () => {
    const betas = buildBetaHeaders('claude-opus-4-7', true);
    expect(betas).toBeUndefined();
  });

  it('omits 1M beta for Opus 4.6 (1M GA)', () => {
    const betas = buildBetaHeaders('claude-opus-4-6', true);
    expect(betas).toBeUndefined();
  });

  it('omits 1M beta for Sonnet 4.6 (1M GA)', () => {
    const betas = buildBetaHeaders('claude-sonnet-4-6', true);
    expect(betas).toBeUndefined();
  });

  it('includes 1M beta for Sonnet 4.5 (still needs header)', () => {
    const betas = buildBetaHeaders('claude-sonnet-4-5-20250929', true);
    expect(betas).toBeDefined();
    expect(betas).toContain('context-1m-2025-08-07');
  });

  it('includes 1M beta for Haiku 4.5 (still needs header)', () => {
    const betas = buildBetaHeaders('claude-haiku-4-5-20251001', true);
    expect(betas).toBeDefined();
    expect(betas).toContain('context-1m-2025-08-07');
  });

  it('includes 1M beta for unknown / empty model name (conservative default)', () => {
    expect(buildBetaHeaders(undefined, true)).toContain('context-1m-2025-08-07');
    expect(buildBetaHeaders('', true)).toContain('context-1m-2025-08-07');
  });
});
