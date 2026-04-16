import { describe, expect, it } from 'vitest';
import {
  calculateTokenCost,
  getContextWindow,
  getMaxOutput,
  getModelPricing,
  getModelSpec,
  PRICING_VERSION,
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
});
