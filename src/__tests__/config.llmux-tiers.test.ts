/**
 * T10 (SSOT 2026-10-23, trinity review) — SOMA_LLMUX_ACCOUNT_TIERS returns the
 * operator's entries only, so the resolver's precedence (explicit scoped →
 * explicit bare → upstream → built-in defaults) is not short-circuited by a
 * default merged in as if it were explicit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAccountTier } from '../auth/llmux-tiers';
import { getLlmuxAccountTiers } from '../config';

describe('getLlmuxAccountTiers', () => {
  afterEach(() => {
    delete process.env.SOMA_LLMUX_ACCOUNT_TIERS;
  });

  it('a bare-name override beats the scoped built-in default', () => {
    process.env.SOMA_LLMUX_ACCOUNT_TIERS = 'ai1=pro500';
    const tiers = getLlmuxAccountTiers();
    expect(tiers).toEqual({ ai1: 'chatgpt-pro-500' });
    expect(resolveAccountTier({ name: 'ai1', group: 'codex' }, tiers)).toBe('chatgpt-pro-500');
  });

  it('unset → no operator entries; the defaults still apply through the resolver', () => {
    const tiers = getLlmuxAccountTiers();
    expect(tiers).toEqual({});
    expect(resolveAccountTier({ name: 'ai5', group: 'codex' }, tiers)).toBe('chatgpt-pro-500');
  });
});
