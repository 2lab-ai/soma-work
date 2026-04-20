import { describe, expect, it } from 'vitest';
import { FUN_FACTS, pickFunFact } from './fun-facts';

// Trace: docs/usage-card-dark/trace.md (fun-fact emoji + human-scale refs)
describe('fun-facts pickFunFact', () => {
  it('0 tokens → empty-state copy', () => {
    expect(pickFunFact(0)).toBe('아직 첫 문단 분량입니다.');
    expect(pickFunFact(-100)).toBe('아직 첫 문단 분량입니다.');
  });

  it('below first entry → fraction copy referencing smallest entry', () => {
    const s = pickFunFact(30_000);
    expect(s).toContain(FUN_FACTS[0].name); // Fahrenheit 451
    expect(s).toMatch(/%/);
  });

  it('100k range → Harry Potter', () => {
    const s = pickFunFact(120_000);
    expect(s).toContain('해리 포터');
    expect(s).toMatch(/x/);
  });

  it('100M range → 대영 백과사전', () => {
    const s = pickFunFact(100_000_000);
    expect(s).toContain('대영 백과사전');
    expect(s).toMatch(/x/);
  });

  it('100B range → 국회도서관', () => {
    const s = pickFunFact(100_000_000_000);
    expect(s).toContain('국회도서관');
    expect(s).toMatch(/x/);
  });
});
