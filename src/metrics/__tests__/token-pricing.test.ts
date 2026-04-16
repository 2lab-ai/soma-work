import { describe, expect, it } from 'vitest';
import { calculateTokenCost, getModelPricing } from '../token-pricing';

describe('token-pricing (wrapper)', () => {
  describe('getModelPricing', () => {
    it('returns legacy ModelPricing shape with cacheCreatePerMTok', () => {
      const pricing = getModelPricing('claude-opus-4-6-20250414');
      expect(pricing.cacheCreatePerMTok).toBe(6.25); // 5-min write tier
      expect(pricing.inputPerMTok).toBe(5);
      expect(pricing.outputPerMTok).toBe(25);
      expect(pricing.cacheReadPerMTok).toBe(0.5);
    });

    it('returns Haiku pricing', () => {
      const pricing = getModelPricing('claude-haiku-4-5-20250414');
      expect(pricing.inputPerMTok).toBe(1);
      expect(pricing.outputPerMTok).toBe(5);
    });

    it('returns fallback for unknown', () => {
      const pricing = getModelPricing('unknown');
      expect(pricing.inputPerMTok).toBe(3);
    });
  });

  describe('calculateTokenCost', () => {
    it('delegates to model-registry', () => {
      const cost = calculateTokenCost('claude-opus-4-6', 1_000_000, 0, 0, 0);
      expect(cost).toBeCloseTo(5, 2);
    });
  });
});
