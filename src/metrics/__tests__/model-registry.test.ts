import { describe, expect, it } from 'vitest';
import {
  calculateTokenCost,
  FALLBACK_CONTEXT_WINDOW,
  getContextWindow,
  getMaxOutput,
  getModelPricing,
  getModelSpec,
  hasOneMSuffix,
  ONE_M_SUFFIX_RE,
  PRICING_VERSION,
  resolveContextWindow,
  stripOneMSuffix,
} from '../model-registry';

describe('model-registry', () => {
  describe('PRICING_VERSION', () => {
    it('should be 2026-04-17', () => {
      expect(PRICING_VERSION).toBe('2026-04-17');
    });
  });

  describe('getModelSpec', () => {
    it('returns Opus 4.7 spec', () => {
      const spec = getModelSpec('claude-opus-4-7');
      expect(spec.pricing.inputPerMTok).toBe(5);
      expect(spec.pricing.outputPerMTok).toBe(25);
      expect(spec.pricing.cacheReadPerMTok).toBe(0.5);
      expect(spec.pricing.cache5minWritePerMTok).toBe(6.25);
      expect(spec.pricing.cache1hrWritePerMTok).toBe(10);
      expect(spec.contextWindow).toBe(1_000_000);
      expect(spec.maxOutput).toBe(128_000);
    });

    it('returns Opus 4.6 spec', () => {
      const spec = getModelSpec('claude-opus-4-6-20250414');
      expect(spec.pricing.inputPerMTok).toBe(5);
      expect(spec.pricing.outputPerMTok).toBe(25);
      expect(spec.pricing.cacheReadPerMTok).toBe(0.5);
      expect(spec.pricing.cache5minWritePerMTok).toBe(6.25);
      expect(spec.pricing.cache1hrWritePerMTok).toBe(10);
      expect(spec.contextWindow).toBe(1_000_000);
      expect(spec.maxOutput).toBe(128_000);
    });

    it('returns Sonnet 4.6 spec', () => {
      const spec = getModelSpec('claude-sonnet-4-6-20250414');
      expect(spec.pricing.inputPerMTok).toBe(3);
      expect(spec.pricing.outputPerMTok).toBe(15);
      expect(spec.contextWindow).toBe(1_000_000);
      expect(spec.maxOutput).toBe(64_000);
    });

    it('returns Haiku 4.5 spec', () => {
      const spec = getModelSpec('claude-haiku-4-5-20250414');
      expect(spec.pricing.inputPerMTok).toBe(1);
      expect(spec.pricing.outputPerMTok).toBe(5);
      expect(spec.contextWindow).toBe(200_000);
    });

    it('returns fallback for unknown model', () => {
      const spec = getModelSpec('gpt-99-turbo');
      expect(spec.pricing.inputPerMTok).toBe(3);
      expect(spec.contextWindow).toBe(200_000);
    });

    it('returns fallback for undefined', () => {
      const spec = getModelSpec(undefined);
      expect(spec.pricing.inputPerMTok).toBe(3);
    });
  });

  describe('getContextWindow', () => {
    it('returns 1M for opus-4-6', () => {
      expect(getContextWindow('claude-opus-4-6-20250414')).toBe(1_000_000);
    });

    it('returns 200k for haiku-4-5', () => {
      expect(getContextWindow('claude-haiku-4-5-20250414')).toBe(200_000);
    });
  });

  describe('getMaxOutput', () => {
    it('returns 128k for opus-4-6', () => {
      expect(getMaxOutput('claude-opus-4-6-20250414')).toBe(128_000);
    });
  });

  describe('calculateTokenCost', () => {
    it('calculates Opus 4.7 cost correctly', () => {
      const cost = calculateTokenCost('claude-opus-4-7', 1_000_000, 1_000_000, 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(36.75, 2);
    });

    it('calculates Opus 4.6 cost correctly', () => {
      // 1M input + 1M output + 1M cache read + 1M cache create
      const cost = calculateTokenCost('claude-opus-4-6-20250414', 1_000_000, 1_000_000, 1_000_000, 1_000_000);
      // 5 + 25 + 0.5 + 6.25 = 36.75
      expect(cost).toBeCloseTo(36.75, 2);
    });

    it('calculates Sonnet 4.6 cost correctly', () => {
      const cost = calculateTokenCost('claude-sonnet-4-6-20250414', 1_000_000, 1_000_000, 0, 0);
      // 3 + 15 = 18
      expect(cost).toBeCloseTo(18, 2);
    });

    it('uses fallback for unknown model', () => {
      const cost = calculateTokenCost('unknown-model', 1_000_000, 0, 0, 0);
      // Sonnet-tier fallback: $3 per 1M input
      expect(cost).toBeCloseTo(3, 2);
    });

    it('handles zero tokens', () => {
      expect(calculateTokenCost('claude-opus-4-6', 0, 0, 0, 0)).toBe(0);
    });
  });

  describe('backward compatibility', () => {
    it('getModelPricing returns pricing spec', () => {
      const pricing = getModelPricing('claude-opus-4-6-20250414');
      expect(pricing.inputPerMTok).toBe(5);
      expect(pricing.cache5minWritePerMTok).toBe(6.25);
    });
  });

  // --- 1M variant helpers (Issue #656) ---

  describe('ONE_M_SUFFIX_RE', () => {
    it('matches trailing [1m] case-insensitively', () => {
      expect(ONE_M_SUFFIX_RE.test('claude-opus-4-7[1m]')).toBe(true);
      expect(ONE_M_SUFFIX_RE.test('claude-opus-4-6[1M]')).toBe(true);
    });

    it('does not match when suffix is absent or not trailing', () => {
      expect(ONE_M_SUFFIX_RE.test('claude-opus-4-7')).toBe(false);
      expect(ONE_M_SUFFIX_RE.test('claude-opus-4-7[1m]-extra')).toBe(false);
    });
  });

  describe('hasOneMSuffix', () => {
    it('returns true for lowercase [1m] suffix', () => {
      expect(hasOneMSuffix('claude-opus-4-7[1m]')).toBe(true);
      expect(hasOneMSuffix('claude-opus-4-6[1m]')).toBe(true);
    });

    it('returns true for uppercase [1M] suffix', () => {
      expect(hasOneMSuffix('claude-opus-4-7[1M]')).toBe(true);
    });

    it('returns false for bare model ids', () => {
      expect(hasOneMSuffix('claude-opus-4-7')).toBe(false);
      expect(hasOneMSuffix('claude-sonnet-4-6')).toBe(false);
      expect(hasOneMSuffix('claude-haiku-4-5-20251001')).toBe(false);
    });
  });

  describe('stripOneMSuffix', () => {
    it('removes the [1m] suffix when present', () => {
      expect(stripOneMSuffix('claude-opus-4-7[1m]')).toBe('claude-opus-4-7');
      expect(stripOneMSuffix('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    });

    it('removes the uppercase [1M] suffix', () => {
      expect(stripOneMSuffix('claude-opus-4-7[1M]')).toBe('claude-opus-4-7');
    });

    it('returns input unchanged when no suffix is present', () => {
      expect(stripOneMSuffix('claude-opus-4-7')).toBe('claude-opus-4-7');
      expect(stripOneMSuffix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    });
  });

  describe('resolveContextWindow', () => {
    it('returns 1_000_000 for [1m] variants (opus-4-7, opus-4-6)', () => {
      expect(resolveContextWindow('claude-opus-4-7[1m]')).toBe(1_000_000);
      expect(resolveContextWindow('claude-opus-4-6[1m]')).toBe(1_000_000);
    });

    it('returns FALLBACK_CONTEXT_WINDOW (200k) for bare opus-4-7 / opus-4-6', () => {
      // Suffix-is-SSOT: bare ids resolve to 200k even for base specs that were 1M.
      expect(resolveContextWindow('claude-opus-4-7')).toBe(FALLBACK_CONTEXT_WINDOW);
      expect(resolveContextWindow('claude-opus-4-6')).toBe(FALLBACK_CONTEXT_WINDOW);
    });

    it('returns 200k for bare sonnet-4-6 (explicit SSOT check)', () => {
      // Regression guard — spec D5: sonnet-4-6 without [1m] is 200k, full stop.
      expect(resolveContextWindow('claude-sonnet-4-6')).toBe(200_000);
    });

    it('returns 200k for haiku-4-5 and opus-4-5', () => {
      expect(resolveContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
      expect(resolveContextWindow('claude-opus-4-5-20251101')).toBe(200_000);
    });

    it('returns FALLBACK_CONTEXT_WINDOW for undefined input', () => {
      expect(resolveContextWindow(undefined)).toBe(FALLBACK_CONTEXT_WINDOW);
    });

    it('FALLBACK_CONTEXT_WINDOW is 200_000', () => {
      expect(FALLBACK_CONTEXT_WINDOW).toBe(200_000);
    });
  });
});
