import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPACT_HEADROOM } from '../../metrics/model-profile';
import type { ConversationSession } from '../../types';
import type { UserSettingsStore } from '../../user-settings-store';
import {
  isAutoCompactReset,
  parseAutoCompactTokens,
  resolveEffectiveAutoCompact,
  safeMaxAutoCompactTokens,
  validateAutoCompactTokensForModel,
} from '../autocompact-policy';

/**
 * Task 3 — session-scoped `/autocompact` token override.
 *
 * The parser answers "what number did the user mean?"; the policy answers
 * "which number does this session actually compact at?". They are separate so
 * a malformed input never reaches the resolver and a legal-but-unsafe number
 * is refused by ONE rule (`safeMaxAutoCompactTokens`) shared by set-time
 * validation, model-default clamping and legacy-percent conversion.
 */
describe('parseAutoCompactTokens', () => {
  it.each([
    ['800k', 800_000],
    ['800K', 800_000],
    ['0.8M', 800_000],
    ['0.8m', 800_000],
    ['800000', 800_000],
    // Bare shorthand: a number under 1000 is thousands (`800` = 800k), because
    // nobody compacts at 800 tokens.
    ['800', 800_000],
    ['750', 750_000],
    ['  340k  ', 340_000],
    // Absolute band boundaries.
    ['100k', 100_000],
    ['1M', 1_000_000],
  ])('parses %s → %i', (raw, expected) => {
    expect(parseAutoCompactTokens(raw)).toBe(expected);
  });

  it('treats "reset" as a reset word, not a number', () => {
    expect(isAutoCompactReset('reset')).toBe(true);
    expect(isAutoCompactReset(' RESET ')).toBe(true);
    expect(parseAutoCompactTokens('reset')).toBeNull();
  });

  it.each(['default', 'off', 'clear', 'none', '800k'])('does not treat "%s" as a reset word', (raw) => {
    expect(isAutoCompactReset(raw)).toBe(false);
  });

  it.each([
    ['abc'],
    [''],
    ['   '],
    ['8k8'],
    ['-5k'],
    ['0'],
    ['0k'],
    ['1e5'],
    ['800kk'],
    ['800 k tokens'],
    // Above the absolute ceiling (1M) — no supported profile has a bigger window.
    ['2M'],
    ['1000001'],
    // Below the absolute floor (100k): compacting that early is never intended.
    ['1.5k'],
    ['99k'],
    ['0.0001M'],
    // Fractional token counts are not a thing.
    ['100.0005k'],
  ])('rejects malformed/out-of-range input %s', (raw) => {
    expect(parseAutoCompactTokens(raw)).toBeNull();
  });
});

/** Minimal session stub — the policy only reads `model` + `autoCompactTokens`. */
function makeSession(model: string, autoCompactTokens?: number | null): ConversationSession {
  return {
    ownerId: 'U1',
    userId: 'U1',
    channelId: 'C1',
    threadTs: '1.1',
    isActive: true,
    lastActivity: new Date(),
    model,
    ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
  } as unknown as ConversationSession;
}

/** Store stub returning a fixed legacy percent. */
function makeStore(pct: number): UserSettingsStore {
  return { getUserCompactThreshold: () => pct } as unknown as UserSettingsStore;
}

describe('safeMaxAutoCompactTokens', () => {
  it('is min(contextWindow, sdkBlockingLimit) − compactHeadroom', () => {
    // 200k profile: min(200_000, 177_000) − 9_000
    expect(safeMaxAutoCompactTokens('claude-opus-5')).toBe(177_000 - DEFAULT_COMPACT_HEADROOM);
    // 1M profile: min(1_000_000, 977_000) − 9_000
    expect(safeMaxAutoCompactTokens('claude-opus-5[1m]')).toBe(977_000 - DEFAULT_COMPACT_HEADROOM);
  });
});

describe('validateAutoCompactTokensForModel', () => {
  it('accepts a threshold at the safe maximum', () => {
    const result = validateAutoCompactTokensForModel(968_000, 'claude-opus-5[1m]');
    expect(result.ok).toBe(true);
  });

  it('rejects a threshold above the safe maximum with a visible reason', () => {
    const result = validateAutoCompactTokensForModel(190_000, 'claude-opus-5');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.safeMax).toBe(168_000);
    expect(result.message).toMatch(/168/);
  });
});

describe('resolveEffectiveAutoCompact', () => {
  it('prefers the session override over the model default', () => {
    const session = makeSession('claude-opus-5[1m]', 400_000);
    expect(resolveEffectiveAutoCompact(session, 'U1', makeStore(80))).toEqual({
      tokens: 400_000,
      source: 'session',
      contextWindow: 1_000_000,
    });
  });

  it('falls back to the model default when there is no override', () => {
    const session = makeSession('claude-opus-5[1m]');
    expect(resolveEffectiveAutoCompact(session, 'U1', makeStore(80))).toEqual({
      tokens: 750_000,
      source: 'model',
      contextWindow: 1_000_000,
    });
  });

  it('falls back to the converted legacy percent when the model has no default', () => {
    // bare opus-5 = 200k window, no declared auto-compact default.
    const session = makeSession('claude-opus-5');
    expect(resolveEffectiveAutoCompact(session, 'U1', makeStore(80))).toEqual({
      tokens: 160_000,
      source: 'legacy-percent',
      contextWindow: 200_000,
    });
  });

  it('caps the legacy percent conversion at the safe maximum', () => {
    // 95% of a 200k window is 190,000 — past the 177,000 SDK block. It must
    // land on the shared safe max (168,000), not on the raw percentage.
    const session = makeSession('claude-opus-5');
    const effective = resolveEffectiveAutoCompact(session, 'U1', makeStore(95));
    expect(effective.tokens).toBe(168_000);
    expect(effective.source).toBe('legacy-percent');
  });

  it('recalculates from the model default when the model switches and no override exists', () => {
    const session = makeSession('claude-opus-5[1m]');
    expect(resolveEffectiveAutoCompact(session, 'U1', makeStore(80)).tokens).toBe(750_000);

    session.model = 'gpt-5.6-sol';
    expect(resolveEffectiveAutoCompact(session, 'U1', makeStore(80))).toEqual({
      tokens: 340_000,
      source: 'model',
      contextWindow: 372_000,
    });
  });

  it('retains the explicit override across a model switch', () => {
    const session = makeSession('claude-opus-5[1m]', 300_000);
    session.model = 'gpt-5.6-sol';
    const effective = resolveEffectiveAutoCompact(session, 'U1', makeStore(80));
    expect(effective).toEqual({ tokens: 300_000, source: 'session', contextWindow: 372_000 });
    // The STORED value is untouched — switching back must restore it verbatim.
    expect(session.autoCompactTokens).toBe(300_000);
  });

  it('clamps a retained override that no longer fits the new model, without rewriting it', () => {
    const session = makeSession('claude-opus-5[1m]', 900_000);
    session.model = 'claude-opus-5';
    const effective = resolveEffectiveAutoCompact(session, 'U1', makeStore(80));
    expect(effective.tokens).toBe(168_000);
    expect(effective.source).toBe('session');
    expect(session.autoCompactTokens).toBe(900_000);
  });

  it('treats a null override as "no override"', () => {
    const session = makeSession('claude-opus-5[1m]', null);
    expect(resolveEffectiveAutoCompact(session, 'U1', makeStore(80)).source).toBe('model');
  });
});
