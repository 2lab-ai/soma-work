import { describe, expect, it, vi } from 'vitest';
import type { NormalizeInput } from '../normalize';
import { normalizeZInvocation, stripZPrefix } from '../normalize';
import type { ZRespond } from '../types';

function makeRespond(): ZRespond {
  return {
    source: 'slash',
    send: vi.fn().mockResolvedValue({}),
    replace: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
  };
}

function makeInput(
  overrides: Partial<NormalizeInput> & { text: string; source: NormalizeInput['source'] },
): NormalizeInput {
  return {
    userId: 'U1',
    channelId: 'C1',
    teamId: 'T1',
    respond: makeRespond(),
    ...overrides,
  };
}

describe('stripZPrefix', () => {
  const CASES: { input: string; expected: string | null }[] = [
    { input: '/z', expected: '' },
    { input: '/z help', expected: 'help' },
    { input: '/Z help', expected: 'help' },
    { input: '/z  persona set  linus ', expected: 'persona set  linus' },
    { input: '/zhelp', expected: null },
    { input: 'help', expected: null },
    { input: '  /z help', expected: null },
    { input: '', expected: null },
    { input: '/z ', expected: '' },
  ];
  CASES.forEach(({ input, expected }) => {
    it(`strips "${input}" → ${JSON.stringify(expected)}`, () => {
      expect(stripZPrefix(input)).toBe(expected);
    });
  });
});

describe('normalizeZInvocation', () => {
  it('slash source: treats text as post-/z remainder', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'slash', text: 'persona set linus' }));
    expect(inv.remainder).toBe('persona set linus');
    expect(inv.isLegacyNaked).toBe(false);
    expect(inv.whitelistedNaked).toBe(false);
    expect(inv.source).toBe('slash');
  });

  it('slash source: empty text → empty remainder', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'slash', text: '' }));
    expect(inv.remainder).toBe('');
  });

  it('dm source: /z prefix strips and marks as /z invocation', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'dm', text: '/z persona set linus' }));
    expect(inv.remainder).toBe('persona set linus');
    expect(inv.rawText).toBe('/z persona set linus');
    expect(inv.isLegacyNaked).toBe(false);
    expect(inv.whitelistedNaked).toBe(false);
  });

  it('channel_mention source: /z prefix recognized', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'channel_mention', text: '/z help' }));
    expect(inv.remainder).toBe('help');
  });

  it('dm source: whitelisted naked (session) → whitelistedNaked=true', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'dm', text: 'session' }));
    expect(inv.whitelistedNaked).toBe(true);
    expect(inv.isLegacyNaked).toBe(false);
    expect(inv.remainder).toBe('session');
  });

  it('dm source: whitelisted naked (new <prompt>) → whitelistedNaked=true', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'dm', text: 'new hello world' }));
    expect(inv.whitelistedNaked).toBe(true);
  });

  it('dm source: legacy naked (persona) → isLegacyNaked=true', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'dm', text: 'persona set linus' }));
    expect(inv.isLegacyNaked).toBe(true);
    expect(inv.whitelistedNaked).toBe(false);
  });

  it('channel_mention source: legacy naked (model) → isLegacyNaked=true', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'channel_mention', text: 'model sonnet' }));
    expect(inv.isLegacyNaked).toBe(true);
  });

  it('unknown prose: both flags false', () => {
    const inv = normalizeZInvocation(makeInput({ source: 'dm', text: 'hello claude how are you' }));
    expect(inv.isLegacyNaked).toBe(false);
    expect(inv.whitelistedNaked).toBe(false);
  });

  it('preserves user/channel/team/threadTs fields', () => {
    const inv = normalizeZInvocation({
      source: 'channel_mention',
      text: '/z help',
      userId: 'U_X',
      channelId: 'C_X',
      threadTs: '123.456',
      teamId: 'T_X',
      respond: makeRespond(),
    });
    expect(inv.userId).toBe('U_X');
    expect(inv.channelId).toBe('C_X');
    expect(inv.threadTs).toBe('123.456');
    expect(inv.teamId).toBe('T_X');
  });
});
