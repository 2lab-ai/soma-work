import { describe, expect, it } from 'vitest';
import * as claudeHandler from './claude-handler';
import { buildThinkingOption, resolveShowSummary } from './claude-handler';
import { DEFAULT_SHOW_THINKING, DEFAULT_THINKING_ENABLED } from './user-settings-store';

describe('buildThinkingOption', () => {
  it('returns adaptive+summarized when thinkingEnabled=true and showSummary=true', () => {
    expect(buildThinkingOption(true, true)).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('returns adaptive+omitted when thinkingEnabled=true and showSummary=false', () => {
    expect(buildThinkingOption(true, false)).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('returns disabled when thinkingEnabled=false (regardless of showSummary)', () => {
    expect(buildThinkingOption(false, true)).toEqual({ type: 'disabled' });
    expect(buildThinkingOption(false, false)).toEqual({ type: 'disabled' });
    expect(buildThinkingOption(false)).toEqual({ type: 'disabled' });
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

describe('buildBetaHeaders removal (#648)', () => {
  // Post-#648: we delegate `[1m]` → 1M-context beta handling to
  // Claude Agent SDK (v0.2.111+), which detects the suffix, strips it
  // before the API call, and injects `context-1m-2025-08-07` uniformly
  // across API-key and OAuth auth. Our own helper was deleted so there
  // is no longer a custom beta-header code path to regress into.
  it('no longer exports buildBetaHeaders', () => {
    expect((claudeHandler as Record<string, unknown>).buildBetaHeaders).toBeUndefined();
  });
});

describe('resolveShowSummary', () => {
  it('session override wins over user default (session=true, user=false)', () => {
    expect(resolveShowSummary(true, false)).toBe(true);
  });

  it('session override wins over user default (session=false, user=true)', () => {
    expect(resolveShowSummary(false, true)).toBe(false);
  });

  it('falls back to user default when no session override', () => {
    expect(resolveShowSummary(undefined, false)).toBe(false);
    expect(resolveShowSummary(undefined, true)).toBe(true);
  });

  it('falls back to DEFAULT_SHOW_THINKING when both undefined', () => {
    expect(resolveShowSummary(undefined, undefined)).toBe(DEFAULT_SHOW_THINKING);
  });
});
