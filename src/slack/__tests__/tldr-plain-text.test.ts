import { describe, expect, it } from 'vitest';
import { followUpFromTldr, plainTldrLine } from '../summary-service';

/**
 * #846 item 7 — the card draws a TL;DR line as plain text. Only the contract's bold (`**x**`) is markup there;
 * double underscores belong to identifiers (`__init__`, `__EFMigrationsHistory`) and stay as written.
 */

describe('plainTldrLine', () => {
  it('unwraps the bold the contract writes', () => {
    expect(plainTldrLine('⚠️ **PR #12 not merged — needs approval.**')).toBe('⚠️ PR #12 not merged — needs approval.');
    expect(plainTldrLine('a **b** c **d**')).toBe('a b c d');
  });

  it.each([
    ['fix the __init__ import order', 'fix the __init__ import order'],
    ['`__init__.py` was missing', '`__init__.py` was missing'],
    ['__EFMigrationsHistory head moved', '__EFMigrationsHistory head moved'],
    ['obj.__dict__ and __slots__ differ', 'obj.__dict__ and __slots__ differ'],
  ])('keeps double underscores in %s', (line, plain) => {
    expect(plainTldrLine(line)).toBe(plain);
  });
});

describe('followUpFromTldr keeps identifiers in the reason', () => {
  it('a dunder inside the ⚠️ line survives', () => {
    expect(followUpFromTldr(['done', '⚠️ **PR #7 open — __init__ import fails in CI**', 'next'])).toEqual({
      reason: 'PR #7 open — __init__ import fails in CI',
    });
  });

  it('a reason that starts or ends with an identifier keeps it', () => {
    expect(followUpFromTldr(['⚠️ __main__ guard missing; PR #8 open'])).toEqual({
      reason: '__main__ guard missing; PR #8 open',
    });
    expect(followUpFromTldr(['⚠️ **PR #9 open: rename __init__**'])).toEqual({ reason: 'PR #9 open: rename __init__' });
  });
});
