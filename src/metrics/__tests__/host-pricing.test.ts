/**
 * RED — one price table for the task total and the subagent rows (SSOT T2/T3).
 *
 * The SDK reports llmux models under their aliases (`astra`, `grok`) and, not
 * knowing them, prices them at its own default. The host resolves an alias
 * through the model catalog and prices every non-Claude model with its own
 * table — the same rates `agent-spend.ts` uses for a subagent's transcript
 * (`gpt-6-astra`, `grok-4.7-build`). Claude models keep the SDK's cost.
 */

import { describe, expect, it } from 'vitest';
import { createHostPricing } from '../host-pricing';
import { calculateTokenCost } from '../model-registry';

const CATALOG = {
  resolveInput: (id: string) =>
    ({ astra: 'gpt-6-astra[1m]', grok: 'grok-4.7', opus: 'claude-opus-5-5[1m]' })[id.toLowerCase()] ??
    (['gpt-6-astra[1m]', 'grok-4.7', 'claude-opus-5-5[1m]'].includes(id.toLowerCase()) ? id.toLowerCase() : null),
  getGroupFor: (id: string) =>
    ({ 'gpt-6-astra[1m]': 'codex', 'grok-4.7': 'grok', 'claude-opus-5-5[1m]': 'claude' })[id.toLowerCase()] ?? null,
};

describe('host pricing — llmux models priced by the host table, Claude by the SDK', () => {
  it('an llmux alias is host-priced at the canonical model’s row', () => {
    const p = createHostPricing(CATALOG);
    expect(p.hostPriced('astra')).toBe(true);
    expect(p.hostPriced('grok')).toBe(true);
    // dev turn 2 of this task: SDK astra in 661,393 / out 28,007 / cache read 4,521,344 → SDK $4.11.
    const astra = p.calculateTokenCost('astra', 661_393, 28_007, 4_521_344, 0);
    expect(astra).toBeCloseTo(calculateTokenCost('gpt-6-astra', 661_393, 28_007, 4_521_344, 0));
    expect(astra).toBeCloseTo(6.61393 + 1.40035 + 4.521344, 4);
    // The subagent transcript names the model `grok-4.7-build`; the SDK says `grok` — same rate either way.
    expect(p.calculateTokenCost('grok', 1e6, 0, 0, 0)).toBeCloseTo(calculateTokenCost('grok-4.7-build', 1e6, 0, 0, 0));
  });

  it('Claude models and models the catalog does not know keep the SDK cost', () => {
    const p = createHostPricing(CATALOG);
    expect(p.hostPriced('claude-opus-5-5[1m]')).toBe(false);
    expect(p.hostPriced('opus')).toBe(false);
    expect(p.hostPriced('claude-haiku-4-5')).toBe(false);
    expect(p.hostPriced('some-unknown-model')).toBe(false);
    expect(p.calculateTokenCost('claude-opus-5-5[1m]', 1e6, 0, 0, 0)).toBeCloseTo(4);
  });

  it('an empty catalog changes nothing (no snapshot: the SDK cost stands)', () => {
    const p = createHostPricing({ resolveInput: () => null, getGroupFor: () => null });
    expect(p.hostPriced('astra')).toBe(false);
    expect(p.calculateTokenCost('gpt-6-astra', 1e6, 0, 0, 0)).toBeCloseTo(10);
  });
});
