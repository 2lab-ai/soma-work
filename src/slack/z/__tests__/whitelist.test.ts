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

describe('isDmAllowedForNonAdmin — lang (#772, a personal setting, never a prompt)', () => {
  it('allows the naked and `/z` forms the LangHandler routes', () => {
    for (const t of [
      'lang',
      'lang ko',
      'lang en',
      'LANG EN',
      '/lang en',
      'lang set en',
      'language en',
      '/z lang en',
      '/z lang',
    ])
      expect(isDmAllowedForNonAdmin(t), t).toBe(true);
  });

  it('still rejects prose that starts with the word', () => {
    expect(isDmAllowedForNonAdmin('language model 비교해줘')).toBe(false);
    expect(isDmAllowedForNonAdmin('lang en please')).toBe(false);
    expect(isDmAllowedForNonAdmin('/z lang en please')).toBe(false);
    expect(isDmAllowedForNonAdmin('/z language model 비교해줘')).toBe(false);
  });
});
