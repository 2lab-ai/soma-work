import { describe, expect, it } from 'vitest';
import { buildThinkingOption, maybeThrowOneMUnavailable, resolveShowSummary } from './claude-handler';
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

// `buildBetaHeaders` was removed in #656. The 1M-context beta header is now
// injected by the Claude Agent SDK itself (≥ 0.2.111) when the model id ends
// with `[1m]` — no runtime wrapper needed on our side.

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

// Issue #661: SDK-emits-message → throw conversion for 1M context unavailable.
// The `streamQuery` async generator pipes every SDK message through this helper
// before yielding. We unit-test the helper directly — streamQuery's hot path is
// `for await (const message of query(...))` { maybeThrowOneMUnavailable(...); yield message }.
describe('maybeThrowOneMUnavailable', () => {
  const buildApiErrorMessage = (text: string) => ({
    type: 'assistant' as const,
    isApiErrorMessage: true,
    message: {
      content: [{ type: 'text', text }],
    },
  });

  it('throws ONE_M_CONTEXT_UNAVAILABLE when model has [1m] suffix and signal matches', () => {
    const message = buildApiErrorMessage(
      'API Error: Extra usage is required for 1M context · run /extra-usage to enable, or /model to switch to standard context',
    );

    expect(() => maybeThrowOneMUnavailable(message as any, 'claude-opus-4-7[1m]')).toThrow();

    try {
      maybeThrowOneMUnavailable(message as any, 'claude-opus-4-7[1m]');
    } catch (err: any) {
      expect(err.code).toBe('ONE_M_CONTEXT_UNAVAILABLE');
      expect(err.attemptedModel).toBe('claude-opus-4-7[1m]');
      expect(String(err.message)).toContain('Extra usage is required for 1M context');
    }
  });

  it('does NOT throw when model is bare (no [1m] suffix) even on matching signal', () => {
    // Bare model must never trigger the fallback throw — the ordinary SDK error
    // flow handles bare-model failures.
    const message = buildApiErrorMessage(
      'API Error: 400 {"error":{"message":"The long context beta is not yet available for this subscription."}}',
    );

    expect(() => maybeThrowOneMUnavailable(message as any, 'claude-opus-4-7')).not.toThrow();
  });

  it('does NOT throw on non-assistant messages', () => {
    const message = { type: 'system' as const, subtype: 'init' };
    expect(() => maybeThrowOneMUnavailable(message as any, 'claude-opus-4-7[1m]')).not.toThrow();
  });

  it('does NOT throw on ordinary assistant messages (no isApiErrorMessage flag)', () => {
    const message = {
      type: 'assistant' as const,
      message: { content: [{ type: 'text', text: 'hello world' }] },
    };
    expect(() => maybeThrowOneMUnavailable(message as any, 'claude-opus-4-7[1m]')).not.toThrow();
  });

  it('does NOT throw when model is undefined', () => {
    const message = buildApiErrorMessage('API Error: Extra usage is required for 1M context');
    expect(() => maybeThrowOneMUnavailable(message as any, undefined)).not.toThrow();
  });

  it('does NOT throw when signal text does not match (different 1m-suffix error)', () => {
    const message = buildApiErrorMessage('API Error: 500 server error');
    expect(() => maybeThrowOneMUnavailable(message as any, 'claude-opus-4-7[1m]')).not.toThrow();
  });
});
