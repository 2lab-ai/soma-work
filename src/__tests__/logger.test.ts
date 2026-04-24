import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installConsoleRedaction, redactAnthropicSecrets } from '../logger';

describe('redactAnthropicSecrets', () => {
  describe('string redaction', () => {
    it('redacts sk-ant-oat01 secrets with last4 preserved', () => {
      const input = 'token is sk-ant-oat01-abcdefghij done';
      expect(redactAnthropicSecrets(input)).toBe('token is [REDACTED sk-ant-oat01-...ghij] done');
    });

    it('redacts sk-ant-ort01 secrets with last4 preserved', () => {
      const input = 'sk-ant-ort01-xyz12345wxyz';
      expect(redactAnthropicSecrets(input)).toBe('[REDACTED sk-ant-ort01-...wxyz]');
    });

    it('redacts sk-ant-api03 secrets with last4 preserved', () => {
      const input = 'Authorization: Bearer sk-ant-api03-QQQQssss1111';
      expect(redactAnthropicSecrets(input)).toBe('Authorization: Bearer [REDACTED sk-ant-api03-...1111]');
    });

    it('redacts sk-ant-admin01 secrets with last4 preserved', () => {
      const input = 'sk-ant-admin01-aaaaBBBBccccDDDD';
      expect(redactAnthropicSecrets(input)).toBe('[REDACTED sk-ant-admin01-...DDDD]');
    });

    it('redacts multiple occurrences within one string', () => {
      const input = 'a=sk-ant-oat01-11112222, b=sk-ant-api03-33334444xxxx';
      expect(redactAnthropicSecrets(input)).toBe(
        'a=[REDACTED sk-ant-oat01-...2222], b=[REDACTED sk-ant-api03-...xxxx]',
      );
    });

    it('leaves unrelated strings untouched', () => {
      expect(redactAnthropicSecrets('hello world')).toBe('hello world');
      expect(redactAnthropicSecrets('sk-ant-unknown-abcdefghij')).toBe('sk-ant-unknown-abcdefghij');
      expect(redactAnthropicSecrets('sk-ant-oat01-short')).toBe('sk-ant-oat01-short'); // < 8 chars
      expect(redactAnthropicSecrets('')).toBe('');
    });
  });

  describe('non-string primitives', () => {
    it('preserves numbers', () => {
      expect(redactAnthropicSecrets(42)).toBe(42);
    });

    it('preserves booleans', () => {
      expect(redactAnthropicSecrets(true)).toBe(true);
      expect(redactAnthropicSecrets(false)).toBe(false);
    });

    it('preserves null', () => {
      expect(redactAnthropicSecrets(null)).toBe(null);
    });

    it('preserves undefined', () => {
      expect(redactAnthropicSecrets(undefined)).toBe(undefined);
    });
  });

  describe('object redaction', () => {
    it('deep-redacts inside nested objects', () => {
      const input = {
        outer: {
          inner: {
            secret: 'sk-ant-oat01-abcdefghij',
            safe: 'nothing to see',
          },
        },
        top: 'sk-ant-api03-topsecret1234',
      };
      const result = redactAnthropicSecrets(input) as typeof input;
      expect(result.outer.inner.secret).toBe('[REDACTED sk-ant-oat01-...ghij]');
      expect(result.outer.inner.safe).toBe('nothing to see');
      expect(result.top).toBe('[REDACTED sk-ant-api03-...1234]');
    });

    it('deep-redacts inside arrays', () => {
      const input = ['sk-ant-oat01-zzzzyyyy', 'safe', { nested: 'sk-ant-ort01-aaaabbbbcccc' }];
      const result = redactAnthropicSecrets(input) as [string, string, { nested: string }];
      expect(result[0]).toBe('[REDACTED sk-ant-oat01-...yyyy]');
      expect(result[1]).toBe('safe');
      expect(result[2].nested).toBe('[REDACTED sk-ant-ort01-...cccc]');
    });

    it('does not mutate the input (referential check)', () => {
      const original = {
        secret: 'sk-ant-oat01-abcdefghij',
        nested: { token: 'sk-ant-api03-wxyzwxyz1234' },
        arr: ['sk-ant-ort01-11112222'],
      };
      const snapshot = JSON.parse(JSON.stringify(original));
      const result = redactAnthropicSecrets(original);

      expect(result).not.toBe(original);
      expect((result as typeof original).nested).not.toBe(original.nested);
      expect((result as typeof original).arr).not.toBe(original.arr);
      expect(original).toEqual(snapshot);
    });

    it('handles circular references without crashing', () => {
      type Cyclic = { name: string; self?: Cyclic };
      const input: Cyclic = { name: 'sk-ant-oat01-cycle1234' };
      input.self = input;

      expect(() => redactAnthropicSecrets(input)).not.toThrow();
      const result = redactAnthropicSecrets(input) as Cyclic;
      expect(result.name).toBe('[REDACTED sk-ant-oat01-...1234]');
      // The cycle is replaced with a sentinel, not a live reference, so no infinite recursion
      expect(result).not.toBe(input);
    });

    it('preserves non-string primitive fields inside objects', () => {
      const input = { n: 1, b: true, nil: null, undef: undefined, s: 'sk-ant-oat01-abcdefghij' };
      const result = redactAnthropicSecrets(input) as typeof input;
      expect(result.n).toBe(1);
      expect(result.b).toBe(true);
      expect(result.nil).toBe(null);
      expect(result.undef).toBe(undefined);
      expect(result.s).toBe('[REDACTED sk-ant-oat01-...ghij]');
    });
  });
});

describe('installConsoleRedaction', () => {
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
    trace: console.trace,
  };

  beforeEach(() => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    console.info = originals.info;
    console.debug = originals.debug;
    console.trace = originals.trace;
  });

  afterEach(() => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    console.info = originals.info;
    console.debug = originals.debug;
    console.trace = originals.trace;
  });

  it('is idempotent (installing twice does not double-wrap)', () => {
    installConsoleRedaction();
    const firstLog = console.log;
    installConsoleRedaction();
    const secondLog = console.log;
    expect(secondLog).toBe(firstLog);
  });

  it('redacts secrets in console.log arguments', () => {
    const buf: unknown[][] = [];
    const original = console.log;
    // Replace first so the installer wraps our spy
    console.log = ((...args: unknown[]) => {
      buf.push(args);
    }) as typeof console.log;

    installConsoleRedaction();
    console.log('hello sk-ant-oat01-abcdefghij world', { token: 'sk-ant-api03-zzzzQQQQ1111' });

    expect(buf).toHaveLength(1);
    expect(buf[0][0]).toBe('hello [REDACTED sk-ant-oat01-...ghij] world');
    expect(buf[0][1]).toEqual({ token: '[REDACTED sk-ant-api03-...1111]' });

    console.log = original;
  });

  it('wraps console.error and console.warn', () => {
    const errBuf: unknown[][] = [];
    const warnBuf: unknown[][] = [];
    const originalErr = console.error;
    const originalWarn = console.warn;

    console.error = ((...args: unknown[]) => {
      errBuf.push(args);
    }) as typeof console.error;
    console.warn = ((...args: unknown[]) => {
      warnBuf.push(args);
    }) as typeof console.warn;

    installConsoleRedaction();
    console.error('boom sk-ant-admin01-zzzzyyyyxxxx');
    console.warn('warn sk-ant-ort01-aaaabbbbcccc');

    expect(errBuf[0][0]).toBe('boom [REDACTED sk-ant-admin01-...xxxx]');
    expect(warnBuf[0][0]).toBe('warn [REDACTED sk-ant-ort01-...cccc]');

    console.error = originalErr;
    console.warn = originalWarn;
  });
});
