/**
 * #881 B3 — the full in-thread Executive Summary turned `__init__` into `_init_`: `formatSummaryForSlack` rewrote
 * every `__x__` as italics, even inside inline code. The TL;DR line already keeps double underscores (#871 — they
 * belong to identifiers: `__init__`, `obj.__dict__`, `__EFMigrationsHistory`); the full summary now does the same,
 * and inline code spans are left exactly as written.
 */
import { describe, expect, it } from 'vitest';
import { SummaryService } from '../summary-service';

const fmt = (s: string) => SummaryService.formatSummaryForSlack(s);

describe('formatSummaryForSlack — identifiers and inline code', () => {
  it.each([
    ['fix the __init__ import order', 'fix the __init__ import order'],
    ['read obj.__dict__ first', 'read obj.__dict__ first'],
    ['the `__init__.py` file was missing', 'the `__init__.py` file was missing'],
    ['call `f(**kwargs)` and `g(**opts)`', 'call `f(**kwargs)` and `g(**opts)`'],
  ])('%s', (input, out) => {
    expect(fmt(input)).toBe(out);
  });

  it('bold around inline code still becomes *bold*; the code inside stays as written (astra R1 P2)', () => {
    expect(fmt('**run `a**b` now** please')).toBe('*run `a**b` now* please');
  });

  it('still turns **bold** into *bold* outside code, and headings into bold lines', () => {
    expect(fmt('a **bold** word, then `**raw**`')).toBe('a *bold* word, then `**raw**`');
    expect(fmt('## Status')).toBe('*Status*');
  });

  it('the TL;DR line formatter keeps inline code too', () => {
    expect(SummaryService.formatTldrLineForSlack('⚠️ **PR #3 open** — `a**b**c` breaks')).toBe(
      '⚠️ *PR #3 open* — `a**b**c` breaks',
    );
  });
});
