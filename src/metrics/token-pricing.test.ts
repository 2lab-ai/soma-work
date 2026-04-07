import { describe, expect, it } from 'vitest';
import { calculateTokenCost, getModelPricing } from './token-pricing';

describe('Token Pricing', () => {
  describe('getModelPricing', () => {
    it('should return Opus 4.6 pricing', () => {
      const pricing = getModelPricing('claude-opus-4-6-20250414');
      expect(pricing.inputPerMTok).toBe(15);
      expect(pricing.outputPerMTok).toBe(75);
      expect(pricing.cacheReadPerMTok).toBe(1.5);
      expect(pricing.cacheCreatePerMTok).toBe(18.75);
    });

    it('should return Sonnet 4.6 pricing', () => {
      const pricing = getModelPricing('claude-sonnet-4-6-20250514');
      expect(pricing.inputPerMTok).toBe(3);
      expect(pricing.outputPerMTok).toBe(15);
    });

    it('should return Haiku 4.5 pricing', () => {
      const pricing = getModelPricing('claude-haiku-4-5-20250301');
      expect(pricing.inputPerMTok).toBe(0.8);
      expect(pricing.outputPerMTok).toBe(4);
    });

    it('should return fallback (Sonnet-tier) for unknown models', () => {
      const pricing = getModelPricing('some-unknown-model');
      expect(pricing.inputPerMTok).toBe(3);
      expect(pricing.outputPerMTok).toBe(15);
    });

    it('should return fallback for undefined model', () => {
      const pricing = getModelPricing(undefined);
      expect(pricing.inputPerMTok).toBe(3);
    });
  });

  describe('calculateTokenCost', () => {
    it('should calculate correct cost for Opus 4.6', () => {
      // 100k input, 50k output, 200k cache read, 10k cache create
      const cost = calculateTokenCost(
        'claude-opus-4-6-20250414',
        100_000, // input
        50_000, // output
        200_000, // cache read
        10_000, // cache create
      );

      // input: 100k/1M * 15 = 1.5
      // output: 50k/1M * 75 = 3.75
      // cacheRead: 200k/1M * 1.5 = 0.3
      // cacheCreate: 10k/1M * 18.75 = 0.1875
      const expected = 1.5 + 3.75 + 0.3 + 0.1875;
      expect(cost).toBeCloseTo(expected, 4);
    });

    it('should calculate correct cost for Sonnet 4.6', () => {
      const cost = calculateTokenCost('claude-sonnet-4-6-20250514', 1_000_000, 100_000, 500_000, 50_000);
      // input: 1M/1M * 3 = 3
      // output: 100k/1M * 15 = 1.5
      // cacheRead: 500k/1M * 0.3 = 0.15
      // cacheCreate: 50k/1M * 3.75 = 0.1875
      const expected = 3 + 1.5 + 0.15 + 0.1875;
      expect(cost).toBeCloseTo(expected, 4);
    });

    it('should return 0 for zero tokens', () => {
      expect(calculateTokenCost('claude-opus-4-6-20250414', 0, 0, 0, 0)).toBe(0);
    });
  });
});
