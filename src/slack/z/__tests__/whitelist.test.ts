import { describe, expect, it } from 'vitest';

import { isDmAllowedForNonAdmin } from '../whitelist';

describe('isDmAllowedForNonAdmin — personal llmux key command', () => {
  it('allows the naked `key` / `auth key` forms (users fetch their own key via DM)', () => {
    expect(isDmAllowedForNonAdmin('key')).toBe(true);
    expect(isDmAllowedForNonAdmin('KEY')).toBe(true);
    expect(isDmAllowedForNonAdmin('auth key')).toBe(true);
    expect(isDmAllowedForNonAdmin('/z auth key')).toBe(true);
  });

  it('accepts every form CommandParser.isAuthCommand routes (grammar parity)', () => {
    expect(isDmAllowedForNonAdmin('/key')).toBe(true);
    expect(isDmAllowedForNonAdmin('/auth key')).toBe(true);
    expect(isDmAllowedForNonAdmin('set auth key')).toBe(true);
  });

  it('still rejects prose that merely contains "key"', () => {
    expect(isDmAllowedForNonAdmin('key rotate please')).toBe(false);
    expect(isDmAllowedForNonAdmin('monkey')).toBe(false);
  });
});

describe('isDmAllowedForNonAdmin — autocompact (config-only, never spawns a prompt)', () => {
  it('allows status/set/reset forms matching CommandParser.isAutoCompactCommand grammar', () => {
    expect(isDmAllowedForNonAdmin('autocompact')).toBe(true);
    expect(isDmAllowedForNonAdmin('AUTOCOMPACT')).toBe(true);
    expect(isDmAllowedForNonAdmin('/autocompact')).toBe(true);
    expect(isDmAllowedForNonAdmin('autocompact 800k')).toBe(true);
    expect(isDmAllowedForNonAdmin('/autocompact 800k')).toBe(true);
    expect(isDmAllowedForNonAdmin('autocompact reset')).toBe(true);
  });

  it('still rejects prose that merely contains "autocompact"', () => {
    expect(isDmAllowedForNonAdmin('please autocompact this')).toBe(false);
    expect(isDmAllowedForNonAdmin('autocompacting now')).toBe(false);
  });
});
