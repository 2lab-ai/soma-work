import { describe, expect, it } from 'vitest';
import { RETRY_REASON_MAX_CHARS, retryReasonLine } from '../retry-reason';

describe('retryReasonLine — the error line a dashboard card shows next to a scheduled resume', () => {
  it('takes the first non-empty line of an Error, string or message-bearing object', () => {
    expect(retryReasonLine(new Error('\n  429 rate-limited  \nstack'))).toBe('429 rate-limited');
    expect(retryReasonLine('timed out\nmore')).toBe('timed out');
    expect(retryReasonLine({ message: 'overloaded (529)' })).toBe('overloaded (529)');
  });

  it('collapses whitespace and bounds the length with an ellipsis', () => {
    expect(retryReasonLine('a \t  b')).toBe('a b');
    const long = retryReasonLine('x'.repeat(RETRY_REASON_MAX_CHARS + 50)) ?? '';
    expect(long).toHaveLength(RETRY_REASON_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('no text → undefined (the card then shows no error line)', () => {
    expect(retryReasonLine(new Error(''))).toBeUndefined();
    expect(retryReasonLine(undefined)).toBeUndefined();
    expect(retryReasonLine(null)).toBeUndefined();
    expect(retryReasonLine('   \n  ')).toBeUndefined();
  });
});
