import { describe, expect, it, vi } from 'vitest';
import { parseFiveBlockPhase } from './config';

// Silence the warn path; we're testing the fallback value, not the log side-effect.
vi.mock('./logger', () => ({
  Logger: class {
    warn = vi.fn();
    info = vi.fn();
    debug = vi.fn();
    error = vi.fn();
  },
}));

describe('parseFiveBlockPhase', () => {
  describe('valid values', () => {
    it.each([
      ['0', 0],
      ['1', 1],
      ['2', 2],
      ['3', 3],
      ['4', 4],
      ['5', 5],
    ])('parses "%s" → %d', (raw, expected) => {
      expect(parseFiveBlockPhase(raw)).toBe(expected);
    });
  });

  describe('fallback to 0', () => {
    it('undefined falls back', () => {
      expect(parseFiveBlockPhase(undefined)).toBe(0);
    });

    it('empty string falls back', () => {
      expect(parseFiveBlockPhase('')).toBe(0);
    });

    it.each([
      ['-1', 'negative'],
      ['6', 'above range'],
      ['10', 'far above range'],
      ['1.5', 'non-integer'],
      ['foo', 'non-numeric'],
      ['true', 'boolean-ish'],
      ['NaN', 'literal NaN'],
      ['Infinity', 'infinity'],
    ])('rejects "%s" (%s) and falls back to 0', (raw) => {
      expect(parseFiveBlockPhase(raw)).toBe(0);
    });
  });

  describe('lenient whitespace tolerance (documents current behavior)', () => {
    // Number() is permissive about surrounding whitespace; this is acceptable
    // because an operator who sets SOMA_UI_5BLOCK_PHASE="1 " still gets the
    // feature enabled rather than a silent rollback to legacy. If a stricter
    // parser is ever desired, add a String.prototype.trim() + regex check.
    it('"1 " parses as 1', () => {
      expect(parseFiveBlockPhase('1 ')).toBe(1);
    });
    it('" 1" parses as 1', () => {
      expect(parseFiveBlockPhase(' 1')).toBe(1);
    });
  });
});
