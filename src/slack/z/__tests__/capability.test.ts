import { describe, expect, it } from 'vitest';

import { isSlashForbidden, SLASH_FORBIDDEN, SLASH_FORBIDDEN_MESSAGE } from '../capability';

describe('SLASH_FORBIDDEN set', () => {
  it('contains the expected forbidden keys', () => {
    expect(SLASH_FORBIDDEN.has('new')).toBe(true);
    expect(SLASH_FORBIDDEN.has('close')).toBe(true);
    expect(SLASH_FORBIDDEN.has('renew')).toBe(true);
    expect(SLASH_FORBIDDEN.has('context')).toBe(true);
    expect(SLASH_FORBIDDEN.has('restore')).toBe(true);
    expect(SLASH_FORBIDDEN.has('link')).toBe(true);
    expect(SLASH_FORBIDDEN.has('compact')).toBe(true);
    expect(SLASH_FORBIDDEN.has('session:set:model')).toBe(true);
    expect(SLASH_FORBIDDEN.has('session:set:verbosity')).toBe(true);
    expect(SLASH_FORBIDDEN.has('session:set:effort')).toBe(true);
    expect(SLASH_FORBIDDEN.has('session:set:thinking')).toBe(true);
    expect(SLASH_FORBIDDEN.has('session:set:thinking_summary')).toBe(true);
  });

  it('keys are all lowercase', () => {
    for (const key of SLASH_FORBIDDEN) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});

describe('isSlashForbidden — table-driven', () => {
  const FORBIDDEN: { args: Parameters<typeof isSlashForbidden>; expected: true }[] = [
    { args: ['new'], expected: true },
    { args: ['close'], expected: true },
    { args: ['renew'], expected: true },
    { args: ['context'], expected: true },
    { args: ['restore'], expected: true },
    { args: ['link'], expected: true },
    { args: ['compact'], expected: true },
    { args: ['session', 'set', 'model'], expected: true },
    { args: ['session', 'set', 'verbosity'], expected: true },
    { args: ['session', 'set', 'effort'], expected: true },
    { args: ['session', 'set', 'thinking'], expected: true },
    { args: ['session', 'set', 'thinking_summary'], expected: true },
    // case-insensitive
    { args: ['NEW'], expected: true },
    { args: ['Session', 'Set', 'Model'], expected: true },
  ];

  FORBIDDEN.forEach(({ args }) => {
    it(`forbids ${JSON.stringify(args)}`, () => {
      expect(isSlashForbidden(...args)).toBe(true);
    });
  });

  const ALLOWED: { args: Parameters<typeof isSlashForbidden> }[] = [
    { args: ['help'] },
    { args: ['persona'] },
    { args: ['persona', 'set', 'linus'] },
    { args: ['model', 'list'] },
    { args: ['session'] },
    { args: ['session', 'set', 'persona'] }, // NOT in set
    { args: ['session', 'list'] },
    { args: ['admin', 'users'] },
    { args: ['mcp', 'list'] },
    { args: ['report', 'today'] },
    { args: [''] }, // empty topic
  ];

  ALLOWED.forEach(({ args }) => {
    it(`allows ${JSON.stringify(args)}`, () => {
      expect(isSlashForbidden(...args)).toBe(false);
    });
  });
});

describe('SLASH_FORBIDDEN_MESSAGE', () => {
  it('is a non-empty Korean user-facing string mentioning /z', () => {
    expect(typeof SLASH_FORBIDDEN_MESSAGE).toBe('string');
    expect(SLASH_FORBIDDEN_MESSAGE.length).toBeGreaterThan(10);
    expect(SLASH_FORBIDDEN_MESSAGE).toContain('/z');
  });
});
