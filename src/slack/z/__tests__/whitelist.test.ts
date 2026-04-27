import { describe, expect, it } from 'vitest';

import { isWhitelistedNaked } from '../whitelist';

describe('isWhitelistedNaked — table-driven', () => {
  const ACCEPT: string[] = [
    // session variants
    'session',
    'sessions',
    'Session',
    'SESSIONS',
    'session public',
    'sessions public',
    'session terminate abc-123',
    'sessions terminate my-key',
    'session theme',
    'session theme dark',
    'session theme set dark',
    'sessions theme=dark',

    // theme variants
    'theme',
    'theme dark',
    'theme set dark',
    'theme=dark',

    // new / renew with optional prompt
    'new',
    'new hello world',
    'renew',
    'renew continue writing',

    // $ prefix
    '$',
    '$model',
    '$model sonnet',
    '$verbosity',
    '$verbosity 3',
    '$effort high',
    '$thinking on',
    '$thinking_summary off',
  ];

  ACCEPT.forEach((input) => {
    it(`accepts "${input}"`, () => {
      expect(isWhitelistedNaked(input)).toBe(true);
    });
  });

  const REJECT: string[] = [
    '',
    '   ',
    'persona set linus', // legacy naked
    'model sonnet',
    'hello', // prose
    'news article about AI', // starts with "new" but not tokenized
    'newer prompt style', // same
    'resession', // not a session command
    '$$model', // double $
    '/z session', // /z prefix not naked
    '$ extra trailing', // 3 tokens is still allowed actually — let me check
  ];

  REJECT.forEach((input) => {
    it(`rejects "${input}"`, () => {
      expect(isWhitelistedNaked(input)).toBe(false);
    });
  });

  it('is case-insensitive for session/new/renew', () => {
    expect(isWhitelistedNaked('SESSION')).toBe(true);
    expect(isWhitelistedNaked('New prompt')).toBe(true);
    expect(isWhitelistedNaked('Renew')).toBe(true);
  });
});
