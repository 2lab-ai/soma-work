import { describe, expect, it, vi } from 'vitest';
import { EsHandler } from './es-handler';

// Trace: docs/turn-summary-lifecycle/trace.md

describe('EsHandler', () => {
  const handler = new EsHandler();

  describe('canHandle()', () => {
    it('matches "es"', () => {
      expect(handler.canHandle('es')).toBe(true);
    });

    it('matches "/es"', () => {
      expect(handler.canHandle('/es')).toBe(true);
    });

    it('matches "ES" (case-insensitive)', () => {
      expect(handler.canHandle('ES')).toBe(true);
    });

    it('matches " es " (trimmed)', () => {
      expect(handler.canHandle(' es ')).toBe(true);
    });

    it('does NOT match "escape"', () => {
      expect(handler.canHandle('escape')).toBe(false);
    });

    it('does NOT match "es something"', () => {
      expect(handler.canHandle('es something')).toBe(false);
    });

    it('does NOT match "test"', () => {
      expect(handler.canHandle('test')).toBe(false);
    });
  });

  describe('execute()', () => {
    it('returns handled: true with continueWithPrompt', async () => {
      const ctx = {
        user: 'U1',
        channel: 'C1',
        threadTs: '171.100',
        text: 'es',
        say: vi.fn(),
      };

      const result = await handler.execute(ctx);

      expect(result.handled).toBe(true);
      expect(result.continueWithPrompt).toBeDefined();
      expect(typeof result.continueWithPrompt).toBe('string');
      expect(result.continueWithPrompt!.length).toBeGreaterThan(0);
    });
  });
});
